import { useState, useMemo, useRef } from 'react'

import {
  pug, styl, observer, $,
  useDoc$,
  useValue$
} from 'startupjs'

import { H1, Button, Div, Br, alert } from '@startupjs/ui'
import { Text, View } from '@/components/Themed'

export default observer(function TabTwoScreen () {
  const $countDoc = useDoc$('testCounts', 'magicCount1')
  if (!$countDoc.get()) throw $countDoc.create({ value: 0 })
  const $count = $countDoc.value
  const $localCount = useValue$(0)
  const [stateCount, setStateCount] = useState(0)
  const idRef = useRef()

  const generateRandomId = (): string | undefined => {
    if (idRef.current == null) idRef.current = $.id()
    return idRef.current
  }

  const randomId = useMemo(generateRandomId, [])
  return pug`
    View.container
      Text.title Tab Two or yes? no? what's 84
      View.separator(lightColor="#eee" darkColor="rgba(255,255,255,0.1)")
      Div(row)
        Button(color='error' onPress=() => $count.increment(-1)) -
        Button(color='primary' variant='flat' pushed onPress=() => $count.increment())
          | Model count: #{$count.get()}
      Br
      H1.count #{$count.get()}
      Br
      View.separator(lightColor="#eee" darkColor="rgba(255,255,255,0.1)")
      Div(row)
        Button(onPress=() => setStateCount(stateCount + 1))
          | State count: #{stateCount}
        Button(pushed onPress=() => $localCount.increment())
          | Local count: #{$localCount.get()}
        Button(pushed onPress=() => alert('Test alert!')) Alert
      View.separator(lightColor="#eee" darkColor="rgba(255,255,255,0.1)")
      Text Random id: #{randomId}
  `
})

styl`
  .count
    color red
  .container
    flex 1
    align-items center
    justify-content center
  .title
    font-size 20px
    font-weight bold
  .separator
    margin 30px 0
    height 1px
    width 80%
`
