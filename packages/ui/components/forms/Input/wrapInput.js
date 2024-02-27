import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { pug, styl, observer } from 'startupjs'
import PropTypes from 'prop-types'
import { faExclamationCircle } from '@fortawesome/free-solid-svg-icons/faExclamationCircle'
import merge from 'lodash/merge'
import Div from './../../Div'
import Icon from './../../Icon'
import Span from './../../typography/Span'
import { useLayout } from './../../../hooks'
import themed from '../../../theming/themed'

const IS_WRAPPED = Symbol('wrapped into wrapInput()')

export function isWrapped (Component) {
  return Component[IS_WRAPPED]
}

export default function wrapInput (Component, configuration) {
  configuration = merge(
    {
      rows: {
        labelPosition: 'top',
        descriptionPosition: 'top'
      },
      isLabelColoredWhenFocusing: false,
      isLabelClickable: false
    },
    configuration
  )

  function InputWrapper ({
    label,
    description,
    layout,
    configuration: componentConfiguration,
    error,
    onFocus,
    required,
    onBlur,
    _onLabelPress,
    ...props
  }, ref) {
    layout = useLayout({
      layout,
      label,
      description
    })

    configuration = merge(configuration, componentConfiguration)
    configuration = merge(configuration, configuration[layout])

    const {
      labelPosition,
      descriptionPosition,
      isLabelColoredWhenFocusing,
      isLabelClickable
    } = configuration

    const [focused, setFocused] = useState(false)

    function handleFocus (...args) {
      setFocused(true)
      onFocus && onFocus(...args)
    }

    function handleBlur (...args) {
      setFocused(false)
      onBlur && onBlur(...args)
    }

    // NOTE
    useEffect(() => {
      if (!isLabelColoredWhenFocusing) return
      if (focused && (props.readonly || props.disabled)) setFocused(false)
    }, [props.readonly, props.disabled])

    const _label = pug`
      if label
        Span.label(
          part='label'
          styleName=[
            layout,
            layout + '-' + labelPosition,
            {
              focused: isLabelColoredWhenFocusing ? focused : false,
              error
            }
          ]
          onPress=isLabelClickable
            ? _onLabelPress
            : undefined
        )
          = label
          if required
            Text.required= ' *'
    `
    const _description = pug`
      if description
        Span.description(
          styleName=[
            layout,
            layout + '-' + descriptionPosition
          ]
          description
        )= description
    `
    const input = pug`
      Component(
        part='wrapper'
        ref=ref
        layout=layout
        _hasError=!!error
        onFocus=handleFocus
        onBlur=handleBlur
        ...props
      )
    `
    const err = pug`
      if error
        Div.errorContainer(
          styleName=[
            layout,
            layout + '-' + descriptionPosition,
          ]
          vAlign='center'
          row
        )
          Icon.errorContainer-icon(icon=faExclamationCircle)
          Span.errorContainer-text= error
    `

    return pug`
      Div.root(
        part='root'
        styleName=[layout]
      )
        if layout === 'rows'
          if labelPosition === 'top'
            = _label
          if descriptionPosition === 'top'
            = _description
            = err
          if labelPosition === 'right'
            Div(vAlign='center' row)
              = input
              = _label
          else
            = input
          if descriptionPosition === 'bottom'
            = err
            = _description
        else if layout === 'columns'
          Div.leftBlock
            = _label
            = _description
          Div.rightBlock
            = input
            = err
        else if layout === 'pure'
          = input
          = err
    `
  }

  const componentDisplayName = Component.displayName || Component.name

  InputWrapper.displayName = componentDisplayName + 'InputWrapper'

  InputWrapper.defaultProps = merge(
    {},
    Component.defaultProps,
    { configuration }
  )

  InputWrapper.propTypes = Object.assign({
    style: PropTypes.oneOfType([PropTypes.object, PropTypes.array]),
    label: PropTypes.string,
    description: PropTypes.string,
    layout: PropTypes.oneOf(['pure', 'rows', 'columns']),
    configuration: PropTypes.shape({
      rows: PropTypes.shape({
        labelPosition: PropTypes.oneOf(['top', 'right']),
        descriptionPosition: PropTypes.oneOf(['top', 'bottom'])
      }),
      isLabelColoredWhenFocusing: PropTypes.bool,
      isLabelClickable: PropTypes.bool
    }),
    error: PropTypes.string,
    required: PropTypes.bool
  }, Component.propTypes)

  const ObservedInputWrapper = observer(
    themed('InputWrapper', InputWrapper),
    { forwardRef: true }
  )

  ObservedInputWrapper[IS_WRAPPED] = true

  return ObservedInputWrapper
}

styl`
  $errorColor = var(--color-text-error)
  $focusedColor = var(--color-text-primary)

  // common
  .label
    align-self flex-start
    font(body2)

    &.focused
      color $focusedColor

    &.error
      color $errorColor

  .description
    font(caption)

  .required
    color $errorColor
    font-weight bold

  .errorContainer
    margin-top 1u
    margin-bottom 0.5u

    &-icon
      color $errorColor

    &-text
      font(caption)
      margin-left 0.5u
      color $errorColor

  // rows
  .rows
    &-top
      .label&
        margin-bottom 0.5u

      .description&
        margin-bottom 1u

      .errorContainer&
        margin-top 0
        margin-bottom 1u

    &-right
      .label&
        margin-left 1u

    &-bottom
      .description&
        margin-top 0.5u

  // columns
  .leftBlock
  .rightBlock
    flex 1

  .leftBlock
    margin-right 1.5u

  .rightBlock
    margin-left 1.5u

  .columns
    .root&
      flex-direction row
      align-items center

`
