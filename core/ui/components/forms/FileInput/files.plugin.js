import { createPlugin } from 'startupjs/registry'
import { Signal, $, sub, BASE_URL, serverOnly } from 'startupjs'
import busboy from 'busboy'
import sharp from 'sharp'
import { GET_FILE_URL, UPLOAD_SINGLE_FILE_URL, DELETE_FILE_URL, getFileUrl, getUploadFileUrl, getDeleteFileUrl } from './constants.js'
import { deleteFile, getFileBlob, saveFileBlob, getDefaultStorageType } from './providers/index.js'

export default createPlugin({
  name: 'files',
  enabled: true,
  order: 'system ui',
  isomorphic: () => ({
    models: models => {
      return {
        ...models,
        files: {
          default: FilesModel,
          schema,
          ...models.files
        },
        'files.*': {
          default: FileModel,
          ...models['files.*']
        }
      }
    }
  }),
  server: () => ({
    serverRoutes: expressApp => {
      expressApp.get(GET_FILE_URL, async (req, res) => {
        let { fileId } = req.params
        // if id has extension, remove it
        // (extension is sometimes added for client libraries to properly handle the file)
        fileId = fileId.replace(/\.[^.]+$/, '')
        // url might have ?download=true which means we should force download
        const download = (req.query?.download != null)
        const $file = await sub($.files[fileId])
        const file = $file.get()
        if (!file) return res.status(404).send(ERRORS.fileNotFound)
        const { mimeType, storageType, filename, updatedAt } = file
        if (!mimeType) return res.status(500).send(ERRORS.fileMimeTypeNotSet)
        if (!storageType) return res.status(500).send(ERRORS.fileStorageTypeNotSet)

        // handle client-side caching of files
        const clientEtag = req.get('If-None-Match')
        const etag = `"${updatedAt}"`
        // lastModified and ifModifiedSince both use UTC time with seconds precision
        const ifModifiedSince = req.get('If-Modified-Since')
        const lastModified = new Date(updatedAt).toUTCString()

        function setCacheHeaders () {
          res.setHeader('Etag', etag)
          res.setHeader('Last-Modified', lastModified)
          if (process.env.NODE_ENV === 'production') {
            res.setHeader('Cache-Control', `public, max-age=${5 * 60}`) // cache on client for 5 mins
          } else {
            res.setHeader('Cache-Control', 'no-cache') // always validate cache in development
          }
          // the following headers are set by expo (metro) dev server.
          // We don't want them since we're setting our own cache headers
          // and a single Cache-Control header fully replaces them.
          res.removeHeader('Pragma')
          res.removeHeader('Surrogate-Control')
          res.removeHeader('Expires')
        }

        if (
          clientEtag === etag ||
          (ifModifiedSince && +new Date(ifModifiedSince) >= +new Date(lastModified))
        ) {
          setCacheHeaders()
          return res.status(304).send() // Not Modified
        }

        try {
          const blob = await getFileBlob(storageType, fileId)
          const fileBuffer = Buffer.from(blob) // Convert BLOB to buffer

          // set the Content-Type header
          res.type(mimeType)

          // force the file to be downloaded by setting the Content-Disposition header
          if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

          setCacheHeaders()

          // send the actual file
          res.send(fileBuffer)
        } catch (err) {
          console.error(err)
          res.status(500).send('Error getting file')
        }
      })

      // this handles both creating and updating a file
      expressApp.post(UPLOAD_SINGLE_FILE_URL, async (req, res) => {
        let { fileId, storageType } = req.params
        try {
          storageType ??= await getDefaultStorageType()
        } catch (err) {
          console.error(err)
          return res.status(500).send('Error getting default storage type')
        }
        const bb = busboy({ headers: req.headers })

        let blob
        let meta
        bb.on('file', (fieldname, file, { filename, mimeType, encoding }) => {
          if (blob) return res.status(500).send('Only one file is allowed')

          const buffers = []
          let stream = file

          if (mimeType.startsWith('image/')) {
            // If it's an image, pipe it through sharp for resizing and conversion
            stream = file.pipe(sharp()
              .rotate()
              .resize(1000, 1000, {
                fit: sharp.fit.inside,
                withoutEnlargement: true
              })
              .toFormat('jpeg', { quality: 80 })) // Convert to JPEG with 85% quality

            filename = filename.replace(/\.[^.]+$/, '.jpg') // Change extension to .jpg
            mimeType = 'image/jpeg'
          }

          // Regardless of whether it's an image or not, collect the data
          stream.on('data', data => buffers.push(data))

          stream.on('end', async () => {
            blob = Buffer.concat(buffers)
            meta = { filename, mimeType, encoding, storageType } // Update meta here to ensure it includes modifications for images

            if (!blob) return res.status(500).send('No file was uploaded')

            // extract extension from filename
            console.log('meta.filename', meta.filename)
            const extension = meta.filename?.match(/\.([^.]+)$/)?.[1]
            if (extension) meta.extension = extension
            const create = !fileId
            if (!fileId) fileId = $.id()
            // try to save file to sqlite first to do an early exit if it fails
            try {
              await saveFileBlob(storageType, fileId, blob)
            } catch (err) {
              console.error(err)
              return res.status(500).send('Error saving file')
            }
            if (create) {
              const doc = { id: fileId, ...meta }
              // if some of the meta fields were undefined, remove them from the doc
              for (const key in meta) {
                if (meta[key] == null) delete doc[key]
              }
              await $.files.addNew(doc)
            } else {
              const $file = await sub($.files[fileId])

              // when changing storageType we should delete the file from the old storageType
              const oldStorageType = $file.storageType.get()
              if (oldStorageType !== meta.storageType) {
                try {
                  await deleteFile(oldStorageType, fileId)
                } catch (err) {
                  console.error(err)
                  return res.status(500).send(`Error deleting file from old storageType ${oldStorageType}`)
                }
              }

              const doc = { ...$file.get(), ...meta, updatedAt: Date.now() }
              // if some of the meta fields were undefined, remove them from the doc
              for (const key in meta) {
                if (meta[key] == null) delete doc[key]
              }
              await $file.set(doc)
            }
            console.log(`Uploaded file to ${storageType}`, fileId)
            res.json({ fileId })
          })
        })

        return req.pipe(bb)
      })

      expressApp.post(DELETE_FILE_URL, async (req, res) => {
        const { fileId } = req.params
        const $file = await sub($.files[fileId])
        const file = $file.get()
        if (!file) return res.status(404).send(ERRORS.fileNotFound)
        const { storageType } = file
        if (!storageType) return res.status(500).send(ERRORS.fileStorageTypeNotSet)
        try {
          await deleteFile(storageType, fileId)
          await $file.del()
          res.json({ fileId })
        } catch (err) {
          console.error(err)
          res.status(500).send('Error deleting file')
        }
      })
    }
  })
})

const schema = {
  storageType: { type: 'string', required: true },
  mimeType: { type: 'string', required: true },
  filename: { type: 'string' }, // original filename with extension
  encoding: { type: 'string' },
  extension: { type: 'string' },
  createdAt: { type: 'number', required: true },
  // updatedAt is used to determine whether the underlying file
  // stored in the storageType provider has changed.
  // This is used to properly cache files on the client side.
  updatedAt: { type: 'number', required: true }
}

class FilesModel extends Signal {
  async addNew (file) {
    const now = Date.now()
    return await this.add({
      ...file,
      createdAt: now,
      updatedAt: now
    })
  }

  getUrl (fileId, extension) {
    return BASE_URL + getFileUrl(fileId, extension)
  }

  getDownloadUrl (fileId, extension) {
    return BASE_URL + getFileUrl(fileId, extension) + '?download=true'
  }

  getUploadUrl (fileId) {
    return BASE_URL + getUploadFileUrl(fileId)
  }

  getDeleteUrl (fileId) {
    return BASE_URL + getDeleteFileUrl(fileId)
  }
}

class FileModel extends Signal {
  getUrl () {
    return BASE_URL + getFileUrl(this.getId(), this.extension.get())
  }

  getDownloadUrl () {
    return this.getUrl() + '?download=true'
  }

  getUploadUrl () {
    return BASE_URL + getUploadFileUrl(this.getId())
  }

  getDeleteUrl () {
    return BASE_URL + getDeleteFileUrl(this.getId())
  }

  getBlob = serverOnly(function () {
    return getFileBlob(this.storageType.get(), this.getId())
  })
}

const ERRORS = {
  fileNotFound: 'File not found',
  fileMimeTypeNotSet: 'File mimeType is not set. This should never happen',
  fileStorageTypeNotSet: 'File storageType is not set. This should never happen'
}
