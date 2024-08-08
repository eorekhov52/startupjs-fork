import { axios, $, sub, Signal } from 'startupjs'
import { createPlugin } from '@startupjs/registry'
import jwt from 'jsonwebtoken'
import { SESSION_KEY } from '../utils/clientSessionData.js'
import createToken from '../utils/createToken.js'
import { AUTH_URL, AUTH_TOKEN_KEY, AUTH_GET_URL, AUTH_FINISH_URL, AUTH_PLUGIN_NAME } from '../utils/constants.js'

export default createPlugin({
  name: AUTH_PLUGIN_NAME,
  order: 'system session',
  enabled () {
    const { enableServer, enableConnection, enableOAuth2 } = this.module.options
    return (enableServer || enableConnection) && enableOAuth2
  },
  isomorphic: ({ enabledProviderIds = PROVIDER_IDS }) => ({
    models: models => {
      return {
        ...models,
        auths: {
          default: Signal,
          ...models.auths,
          schema: {
            ...getAuthsSchema(enabledProviderIds),
            ...models.auths?.schema
          }
        },
        users: {
          default: Signal,
          ...models.users,
          schema: {
            ...getUsersSchema(),
            ...models.users?.schema
          }
        }
      }
    }
  }),
  server: ({ providers }) => {
    return {
      beforeSession (expressApp) {
        expressApp.post(AUTH_GET_URL, (req, res) => {
          try {
            const { provider, extraScopes } = req.body
            if (!provider) return res.status(400).send('Provider is not specified')
            const url = getAuthUrl(req, provider, providers, { extraScopes })
            res.json({ url })
          } catch (err) {
            console.error(err)
            res.status(500).json({ error: 'Error during auth' })
          }
        })
        expressApp.get(`${AUTH_URL}/:provider/callback`, async (req, res) => {
          try {
            const { provider } = req.params
            const config = getProviderConfig(providers, provider)
            if (!config) return res.status(400).send(`Provider ${provider} is not supported`)
            const { code } = req.query
            if (!code) return res.status(400).send('Code is missing')
            let { state } = req.query
            try { state = JSON.parse(state) } catch (err) {}
            if (typeof state !== 'object') return res.status(400).send('State is invalid')
            const { scopes } = state
            if (!Array.isArray(scopes)) return res.status(400).send('Returned scopes are invalid')
            const redirectUri = getRedirectUri(req, provider)
            const accessToken = await getAccessToken(config, provider, { code, redirectUri })
            const userinfo = await getUserinfo(config, provider, { token: accessToken })
            const $auth = await getOrCreateAuth(
              config, provider, { userinfo, token: accessToken, scopes }
            )
            const userId = $auth.getId()
            const payload = { userId, loggedIn: true, authProviderIds: $auth.providerIds.get() }
            const token = await createToken(payload)
            const session = { ...payload, token }
            if (state.platform === 'web') {
              res.setHeader('Content-Type', 'text/html')
              res.send(getSuccessHtml(session, state.redirectUrl))
            } else {
              const sessionEncoded = encodeURIComponent(JSON.stringify(session))
              res.redirect(`${AUTH_FINISH_URL}?${AUTH_TOKEN_KEY}=${sessionEncoded}`)
            }
          } catch (err) {
            console.error(err)
            res.status(500).send('Error during auth')
          }
        })
        expressApp.get(AUTH_FINISH_URL, (req, res) => {
          res.send('Authenticated successfully')
        })
      }
    }
  }
})

function getSuccessHtml (session, redirectUrl) {
  return `<script>
    localStorage.setItem('${SESSION_KEY}', '${JSON.stringify(session)}');
    window.location.href = '${redirectUrl || '/'}';
  </script>`
}

function getAuthUrl (req, provider, providers, { extraScopes } = {}) {
  const config = getProviderConfig(providers, provider)
  if (!config) throw Error(`Provider ${provider} is not supported`)
  const redirectUri = getRedirectUri(req, provider)
  return _getAuthUrl(config, provider, { redirectUri, extraScopes })
}

function getRedirectUri (req, provider) {
  const baseUrl = `${req.protocol}://${req.headers.host}`
  return `${baseUrl}${AUTH_URL}/${provider}/callback`
}

function _getAuthUrl (config, provider, { redirectUri, extraScopes = [] }) {
  const { authUrl } = config
  const clientId = getClientId(config, provider)
  let { scopes } = config
  if (!scopes) throw Error(ERRORS.missingScopes(provider))
  scopes = [...new Set([...scopes, ...extraScopes])]
  const params = new URLSearchParams(Object.entries({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' ')
  })).toString()
  return `${authUrl}?${params}`
}

async function getAccessToken (config, provider, { redirectUri, code }) {
  const { tokenUrl } = config
  if (!tokenUrl) throw Error(`Token URL is missing for provider ${provider}`)
  const clientId = getClientId(config, provider)
  const clientSecret = getClientSecret(config, provider)
  const res = await axios.post(tokenUrl, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })
  let token
  if (typeof res.data === 'string') {
    if (res.data.startsWith('error=')) throw Error(`Error response from ${tokenUrl}: ${res.data}`)
    const params = new URLSearchParams(res.data)
    token = params.get('access_token')
  } else if (typeof res.data === 'object') {
    token = res.data.access_token
  } else {
    throw Error(`Unexpected response from ${tokenUrl}`)
  }
  if (!token) throw Error(`Token is missing in response from ${tokenUrl}`)
  return token
}

function getClientId (config, provider) {
  const clientId = (
    config.getClientId?.() ||
    config.clientId ||
    process.env[`${provider.toUpperCase()}_CLIENT_ID`]
  )
  if (!clientId) throw Error(`Env var ${provider.toUpperCase()}_CLIENT_ID is missing`)
  return clientId
}

function getClientSecret (config, provider) {
  const clientSecret = (
    config.getClientSecret?.() ||
    config.clientSecret ||
    process.env[`${provider.toUpperCase()}_CLIENT_SECRET`]
  )
  if (!clientSecret) throw Error(`Env var ${provider.toUpperCase()}_CLIENT_SECRET is missing`)
  return clientSecret
}

function getProviderConfig (providers = {}, provider) {
  if (!(providers[provider] || DEFAULT_PROVIDERS[provider])) return undefined
  return {
    ...DEFAULT_PROVIDERS[provider],
    ...providers[provider],
    scopes: [...new Set([
      ...(DEFAULT_PROVIDERS[provider]?.scopes || []),
      ...(providers[provider]?.scopes || [])
    ])] // merge default scopes with additional custom scopes
  }
}

async function getUserinfo (config, provider, { token }) {
  const { userinfoUrl } = config
  if (userinfoUrl) {
    const res = await axios.get(userinfoUrl, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const userinfo = res.data
    if (!userinfo) throw Error(`Userinfo is missing in response from ${userinfoUrl}`)
    return userinfo
  } else {
    const decoded = jwt.decode(token)
    if (!decoded) throw Error(ERRORS.missingUserinfoUrl(provider))
    return decoded
  }
}

async function getOrCreateAuth (config, provider, { userinfo, token, scopes } = {}) {
  const { id: providerUserId, ...privateInfo } = getPrivateInfo(config, userinfo)
  const publicInfo = getPublicInfo(config, userinfo)
  async function updateProviderInfo ($auth) {
    const raw = config.saveRawUserinfo ? userinfo : undefined
    addProviderToAuth($auth, provider, { providerUserId, privateInfo, publicInfo, raw, token, scopes })
    return $auth
  }
  // first try to find the exact match with the provider's id
  {
    const [$auth] = await sub($.auths, { [`${provider}.id`]: providerUserId })
    // TODO: update user info if it was changed
    if ($auth) return await updateProviderInfo($auth)
  }
  // then see if we already have a user with such email but without this provider.
  // If the provider is trusted (it definitely provides correct and confirmed email),
  // then we can merge the provider into the existing user.
  if (config.allowAutoMergeByEmail && privateInfo.email) {
    const [$auth] = await sub($.auths, { email: privateInfo.email, [provider]: { $exists: false } })
    if ($auth) return await updateProviderInfo($auth)
  }
  // create a new user
  {
    const userId = await $.auths.add({ ...privateInfo, createdAt: Date.now() })
    const $auth = await sub($.auths[userId]) // subscribe to the new user just to keep a reference
    return await updateProviderInfo($auth)
  }
}

async function addProviderToAuth (
  $auth,
  provider,
  { providerUserId, privateInfo, publicInfo, raw, token, scopes }
) {
  await $auth[provider].set({ id: providerUserId, ...privateInfo, ...publicInfo, raw, token, scopes })
  const providerIds = $auth.providerIds.get() || []
  if (!providerIds.includes(provider)) await $auth.providerIds.push(provider)
  const userId = $auth.getId()
  // update public info of the user if it's missing
  const $user = await sub($.users[userId])
  if ($user.get()) {
    for (const key in publicInfo) {
      if ($user[key].get() == null && publicInfo[key] != null) await $user[key].set(publicInfo[key])
    }
  } else {
    await $.users[userId].set({ ...publicInfo, createdAt: Date.now() })
  }
}

function getPrivateInfo (config, userinfo) {
  const privateInfo = config.getPrivateInfo?.(userinfo) || defaultGetPrivateInfo(userinfo)
  if (!privateInfo?.id) throw Error('Userinfo: id is missing')
  return privateInfo
}

function getPublicInfo (config, userinfo) {
  return config.getPublicInfo?.(userinfo) || defaultGetPublicInfo(userinfo)
}

const PROVIDER_IDS = ['google', 'github']
const DEFAULT_PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: ['openid', 'profile', 'email'],
    getPrivateInfo: ({ sub, email }) => ({ id: sub, email }),
    getPublicInfo: ({ name, picture }) => ({ name, avatarUrl: picture }),
    allowAutoMergeByEmail: true,
    saveRawUserinfo: true
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    scopes: ['user:email'],
    getPrivateInfo: ({ id, email }) => ({ id, email }),
    // eslint-disable-next-line camelcase
    getPublicInfo: ({ name, avatar_url }) => ({ name, avatarUrl: avatar_url }),
    allowAutoMergeByEmail: true,
    saveRawUserinfo: true
  }
}

function defaultGetPrivateInfo (userinfo) {
  const email = userinfo.email
  const id = userinfo.id || userinfo.sub || userinfo.user_id || userinfo.email || userinfo.login
  return { id, email }
}

function defaultGetPublicInfo (userinfo) {
  const name = userinfo.displayName || userinfo.name || userinfo.nickname || userinfo.username || userinfo.login
  const potentialAvatarKeys = [
    'avatarUrl', 'avatar_url', 'avatarURL', 'avatar', 'photoUrl', 'photo_url', 'photoURL', 'photo',
    'pictureUrl', 'picture_url', 'pictureURL', 'picture', 'image', 'imageUrl', 'image_url', 'imageURL'
  ]
  let avatarUrl
  for (const key of potentialAvatarKeys) {
    if (userinfo[key]) {
      avatarUrl = userinfo[key]
      break
    }
  }
  return { name, avatarUrl }
}

export function getAuthsSchema (enabledProviderIds) {
  return {
    email: { type: 'string' },
    createdAt: { type: 'number', required: true },
    ...enabledProviderIds.reduce((acc, providerId) => ({
      ...acc,
      [providerId]: {
        id: { type: 'string', required: true },
        email: { type: 'string' },
        name: { type: 'string' },
        avatarUrl: { type: 'string' },
        raw: { type: 'object' }
      }
    }), {})
  }
}

export function getUsersSchema () {
  return {
    name: { type: 'string' },
    avatarUrl: { type: 'string' },
    createdAt: { type: 'number', required: true }
  }
}

const ERRORS = {
  missingUserinfoUrl: provider => `
    \`userinfoUrl\` is missing for provider ${provider}.
    And the access_token is an opaque token instead of JWT so no user information can be extracted from it.
  `,
  missingScopes: provider => `Scopes are missing for provider ${provider}`
}