import React from 'react'
import { pug, observer } from 'startupjs'
import Portal from '../Portal'
import { useToasts } from './helpers'
import Toast from './Toast'

export default observer(function ToastProvider () {
  const [toasts] = useToasts()

  if (!toasts.length) return null

  return pug`
    Portal
      each toast in toasts
        Toast(...toast)
  `
})
