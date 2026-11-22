import { useMemo, useRef, useState } from 'react'
import { PanResponder, Pressable, ScrollView, Vibration, View } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { frequencies31 } from '@/plugins/player/soundEffect/config'

/**
 * Aurora-28：31 段均衡器的最终交互（老板定稿）
 *
 *  · 上面：曲线图固定不动，只做显示 —— 调值的时候对应圆点实时上下跑。
 *  · 下面：31 个【横向进度条】做成卡片，屏幕上一排 3 个多，左右滑像刷歌单一样切频段。
 *  · 防误触：滑卡片时进度条是锁死的；【长按 0.2 秒】进度条发光 + 轻震，才解锁，
 *    此时左右推拉才加减 dB。松手立刻重新锁死。
 *
 * 曲线不是示意图：按 RBJ peaking 系数（Q=4.318，三分之一倍频程）算复数模，
 * 31 段级联相乘再取 dB，并且跟着真实采样率走。
 */

const F_MIN = 20
const F_MAX = 20000
const DB_SPAN = 15
const Q = 4.318474
const POINTS = 48
const CARD_GAP = 8
const CARD_VISIBLE = 3.2
const UNLOCK_MS = 200

const clamp = (value: number, min: number, max: number) => value < min ? min : value > max ? max : value
const roundHalf = (value: number) => Math.round(value * 2) / 2
const freqToX = (f: number, w: number) => Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN) * w
const dbToY = (db: number, h: number) => (DB_SPAN - clamp(db, -DB_SPAN, DB_SPAN)) / (DB_SPAN * 2) * h

const formatFreq = (f: number) => f >= 1000
  ? (f % 1000 == 0 ? f / 1000 + ' kHz' : (f / 1000).toFixed(1) + ' kHz')
  : (f % 1 == 0 ? f + ' Hz' : f.toFixed(1) + ' Hz')

interface BandCoef { b0: number, b1: number, b2: number, a1: number, a2: number }

const bandCoef = (freq: number, sampleRate: number, gainDb: number): BandCoef | null => {
  if (!(sampleRate > 0) || freq >= sampleRate * 0.48) return null
  const a = Math.pow(10, gainDb / 40)
  const w0 = 2 * Math.PI * freq / sampleRate
  const alpha = Math.sin(w0) / (2 * Q)
  const a0 = 1 + alpha / a
  const b1 = (-2 * Math.cos(w0)) / a0
  return { b0: (1 + alpha * a) / a0, b1, b2: (1 - alpha * a) / a0, a1: b1, a2: (1 - alpha / a) / a0 }
}

/** 48 个取样点的总响应（dB）：只有非零段参与，31 段全平时几乎不耗时 */
const responseOf = (gains: number[], sampleRate: number): number[] => {
  const points: { c1: number, s1: number, c2: number, s2: number }[] = []
  for (let i = 0; i < POINTS; i++) {
    const f = F_MIN * Math.pow(F_MAX / F_MIN, i / (POINTS - 1))
    const w = 2 * Math.PI * f / sampleRate
    points.push({ c1: Math.cos(w), s1: Math.sin(w), c2: Math.cos(2 * w), s2: Math.sin(2 * w) })
  }
  const active: BandCoef[] = []
  for (let i = 0; i < gains.length; i++) {
    if (Math.abs(gains[i]) < 0.01) continue
    const coef = bandCoef(frequencies31[i], sampleRate, gains[i])
    if (coef != null) active.push(coef)
  }
  const out: number[] = []
  for (let i = 0; i < POINTS; i++) {
    const p = points[i]
    let mag = 1
    for (const c of active) {
      const re = c.b0 + c.b1 * p.c1 + c.b2 * p.c2
      const im = -(c.b1 * p.s1 + c.b2 * p.s2)
      const dr = 1 + c.a1 * p.c1 + c.a2 * p.c2
      const di = -(c.a1 * p.s1 + c.a2 * p.s2)
      mag *= Math.sqrt((re * re + im * im) / ((dr * dr + di * di) || 1))
    }
    out.push(clamp(20 * Math.log10(mag || 1), -DB_SPAN, DB_SPAN))
  }
  return out
}

export interface SoundEffectEq31Props {
  gains: number[]
  sampleRate: number
  /** 拖动中（内部节流到 ~80ms 一次） */
  onChange?: (gains: number[]) => void
  /** 松手/点按钮：一次性落地 */
  onCommit: (gains: number[]) => void
}

export default ({ gains, sampleRate, onChange, onCommit }: SoundEffectEq31Props) => {
  const theme = useTheme()
  const [draft, setDraft] = useState<number[] | null>(null)
  const [graph, setGraph] = useState({ w: 0, h: 0 })
  const [carWidth, setCarWidth] = useState(0)
  const [focus, setFocus] = useState(-1)      // 已解锁的频段（-1 = 全部锁死）
  const [dragging, setDragging] = useState(false)
  const [selected, setSelected] = useState(-1)

  const latest = useRef({ gains, sampleRate, onChange, onCommit })
  latest.current = { gains, sampleRate, onChange, onCommit }

  const draftRef = useRef<number[] | null>(null)
  const history = useRef<number[][]>([])
  const carRef = useRef<ScrollView>(null)
  const tap = useRef<{ x: number, y: number, t: number, moved: boolean } | null>(null)
  const drag = useRef({ index: -1, active: false, dragging: false, startVal: 0, trackW: 1, base: [] as number[] })
  const lastEmit = useRef(0)

  const shown = draft ?? gains
  const cardW = carWidth > 0 ? Math.max(74, (carWidth - CARD_GAP * 3) / CARD_VISIBLE) : 96
  const step = cardW + CARD_GAP

  const curve = useMemo(() => responseOf(shown, sampleRate || 48000), [shown, sampleRate])

  const points = useMemo(() => {
    if (graph.w <= 0 || graph.h <= 0) return [] as { x: number, y: number }[]
    return curve.map((db, i) => ({ x: (i / (POINTS - 1)) * graph.w, y: dbToY(db, graph.h) }))
  }, [curve, graph])

  const nodes = useMemo(() => {
    if (graph.w <= 0 || graph.h <= 0) return [] as { index: number, x: number, y: number }[]
    const list: { index: number, x: number, y: number }[] = []
    for (let i = 0; i < shown.length; i++) {
      if (Math.abs(shown[i]) < 0.5 && i !== focus && i !== selected) continue
      list.push({ index: i, x: freqToX(frequencies31[i], graph.w), y: dbToY(shown[i], graph.h) })
    }
    return list
  }, [shown, graph, focus, selected])

  const paint = (next: number[], force: boolean) => {
    draftRef.current = next
    setDraft(next)
    const now = Date.now()
    if (force || now - lastEmit.current > 80) {
      lastEmit.current = now
      latest.current.onChange?.(next)
    }
  }

  const finish = (next: number[] | null) => {
    const done = next ?? draftRef.current
    draftRef.current = null
    setDraft(null)
    if (done != null) latest.current.onCommit(done)
  }

  const lock = () => {
    const next = draftRef.current
    drag.current = { index: -1, active: false, dragging: false, startVal: 0, trackW: 1, base: [] }
    setFocus(-1)
    setDragging(false)
    if (next != null) finish(next)
  }

  /** 长按 0.2 秒解锁：发光 + 轻震，之后左右推拉才动 dB */
  const unlock = (index: number) => {
    const base = latest.current.gains.slice()
    drag.current = { index, active: true, dragging: false, startVal: base[index], trackW: Math.max(40, cardW - 20), base }
    draftRef.current = base
    setFocus(index)
    setSelected(index)
    Vibration.vibrate(12)
  }

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (e, g) => drag.current.active && Math.abs(g.dx) > 2,
    // 已经解锁：谁来抢都不给，保证推拉过程不被打断
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: () => {
      drag.current.dragging = true
      setDragging(true)
    },
    onPanResponderMove: (e, g) => {
      const d = drag.current
      if (d.index < 0) return
      const next = draftRef.current != null ? draftRef.current.slice() : d.base.slice()
      const delta = (g.dx / Math.max(1, d.trackW)) * DB_SPAN * 2
      next[d.index] = roundHalf(clamp(d.startVal + delta, -DB_SPAN, DB_SPAN))
      paint(next, false)
    },
    onPanResponderRelease: () => { lock() },
    onPanResponderTerminate: () => { lock() },
  })).current

  const jumpTo = (index: number) => {
    setSelected(index)
    carRef.current?.scrollTo({ x: Math.max(0, index * step - step), animated: true })
  }

  const toolbar = (label: string, onPress: () => void, disabled = false, primary = false) => {
    const accent = theme['c-primary'] as string
    return (
      <Pressable key={label} disabled={disabled} onPress={onPress} style={{
        ...styles.toolBtn,
        opacity: disabled ? 0.35 : 1,
        borderColor: primary ? accent : (theme['c-border-background'] as string),
        backgroundColor: primary ? (theme['c-primary-alpha-100'] as string) : 'transparent',
      }}>
        <Text size={12} color={primary ? accent : (theme['c-font-label'] as string)}>{label}</Text>
      </Pressable>
    )
  }

  const accent = theme['c-primary'] as string
  const lineColor = theme['c-border-background'] as string
  const gridV = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
  const gridH = [12, 6, 0, -6, -12]
  const highlighted = focus >= 0 ? focus : selected

  return (
    <View>
      {/* ---------------- 曲线（固定不动，只跟着数值动） ---------------- */}
      <View
        style={styles.graphWrap}
        onLayout={e => { setGraph({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }) }}
        onTouchStart={e => { tap.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY, t: Date.now(), moved: false } }}
        onTouchMove={e => {
          const t = tap.current
          if (t == null) return
          if (Math.abs(e.nativeEvent.locationX - t.x) > 8 || Math.abs(e.nativeEvent.locationY - t.y) > 8) t.moved = true
        }}
        onTouchEnd={() => {
          const t = tap.current
          tap.current = null
          if (t == null || t.moved || Date.now() - t.t > 400 || graph.w <= 0) return
          // 点曲线 = 把那一段滑到眼前（卡片区跟着跳）
          let nearest = 0
          let best = Infinity
          for (let i = 0; i < frequencies31.length; i++) {
            const d = Math.abs(freqToX(frequencies31[i], graph.w) - t.x)
            if (d < best) { best = d; nearest = i }
          }
          jumpTo(nearest)
        }}
      >
        <View style={{ ...styles.graphBg, backgroundColor: theme['c-primary-alpha-900'] as string }} />
        {graph.w > 0 && gridH.map(db => (
          <View key={'h' + db} style={{
            position: 'absolute', left: 0, right: 0, top: dbToY(db, graph.h),
            height: db == 0 ? 1.5 : 1, backgroundColor: lineColor, opacity: db == 0 ? 0.9 : 0.32,
          }} />
        ))}
        {graph.w > 0 && gridV.map(f => (
          <View key={'v' + f} style={{
            position: 'absolute', top: 0, bottom: 0, left: freqToX(f, graph.w),
            width: 1, backgroundColor: lineColor, opacity: f == 1000 ? 0.5 : 0.2,
          }} />
        ))}
        {points.slice(0, -1).map((p, i) => {
          const q = points[i + 1]
          const cy = (p.y + q.y) / 2
          const height = graph.h - cy
          if (height <= 0) return null
          return <View key={'f' + i} style={{
            position: 'absolute', left: p.x, top: cy, width: Math.max(1, q.x - p.x + 0.4), height,
            backgroundColor: accent, opacity: 0.1,
          }} />
        })}
        {points.slice(0, -1).map((p, i) => {
          const q = points[i + 1]
          const dx = q.x - p.x
          const dy = q.y - p.y
          const len = Math.sqrt(dx * dx + dy * dy)
          if (len < 0.01) return null
          return (
            <View key={'l' + i} style={{
              position: 'absolute', left: (p.x + q.x) / 2 - len / 2, top: (p.y + q.y) / 2 - 1.25,
              width: len, height: 2.5, borderRadius: 1.25, backgroundColor: accent,
              transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
            }} />
          )
        })}
        {highlighted >= 0 && graph.w > 0 && (
          <View style={{
            position: 'absolute', top: 0, bottom: 0,
            left: freqToX(frequencies31[highlighted], graph.w), width: 1,
            backgroundColor: accent, opacity: 0.55,
          }} />
        )}
        {nodes.map(node => (
          <View key={'n' + node.index} style={{
            position: 'absolute', left: node.x - (node.index === highlighted ? 7 : 5),
            top: node.y - (node.index === highlighted ? 7 : 5),
            width: node.index === highlighted ? 14 : 10,
            height: node.index === highlighted ? 14 : 10,
            borderRadius: 7, borderWidth: 2, borderColor: accent,
            backgroundColor: node.index === highlighted ? accent : (theme['c-primary-alpha-900'] as string),
          }} />
        ))}
      </View>
      <View style={styles.axisRow}>
        <Text size={10} color={theme['c-font-label']}>20 Hz</Text>
        <Text size={10} color={theme['c-font-label']}>200</Text>
        <Text size={10} color={theme['c-font-label']}>1 kHz</Text>
        <Text size={10} color={theme['c-font-label']}>10 k</Text>
        <Text size={10} color={theme['c-font-label']}>20 kHz</Text>
      </View>

      <View style={styles.toolRow}>
        {toolbar('撤销', () => {
          const prev = history.current.pop()
          if (prev != null) latest.current.onCommit(prev)
          else Vibration.vibrate(8)
        }, history.current.length === 0)}
        {toolbar('平滑', () => {
          const next = shown.map((value, i) => {
            const left = shown[Math.max(0, i - 1)]
            const right = shown[Math.min(shown.length - 1, i + 1)]
            return roundHalf(clamp(left * 0.25 + value * 0.5 + right * 0.25, -DB_SPAN, DB_SPAN))
          })
          const prev = shown.slice()
          latest.current.onCommit(next)
          history.current.push(prev)
          if (history.current.length > 24) history.current.shift()
        })}
        <View style={styles.toolSpacer} />
        <Text size={11} color={theme['c-font-label']}>
          {highlighted >= 0 ? `${formatFreq(frequencies31[highlighted])} · ${shown[highlighted] > 0 ? '+' : ''}${shown[highlighted].toFixed(1)} dB` : '点曲线上的点可跳到那一段'}
        </Text>
      </View>

      {/* ---------------- 卡片式横向进度条 ---------------- */}
      <View onLayout={e => { setCarWidth(e.nativeEvent.layout.width) }} style={styles.carWrap}>
        <ScrollView
          ref={carRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={step}
          decelerationRate="fast"
          // 已解锁 = 冻结卡片：这时候左右滑是推拉进度条，不是切卡片
          scrollEnabled={focus < 0}
          contentContainerStyle={styles.carContent}
        >
          {shown.map((value, index) => {
            const unlocked = focus === index
            const trackW = cardW - 20
            const ratio = (value + DB_SPAN) / (DB_SPAN * 2)
            const pos = clamp(ratio * trackW, 0, trackW)
            const center = trackW / 2
            const fillLeft = Math.min(center, pos)
            const fillWidth = Math.abs(pos - center)
            const thumbLeft = pos - 7
            return (
              <View key={index} style={{ width: cardW, marginRight: CARD_GAP }}>
                <View
                  {...(unlocked ? pan.panHandlers : {})}
                  style={{
                    ...styles.card,
                    borderColor: unlocked ? accent : (theme['c-border-background'] as string),
                    backgroundColor: unlocked ? (theme['c-primary-alpha-100'] as string) : (theme['c-primary-alpha-900'] as string),
                  }}
                >
                  <Pressable
                    // 长按 0.2 秒解锁（松手没拖动的话，onPressOut 会把它重新锁上）
                    delayLongPress={UNLOCK_MS}
                    onLongPress={() => { unlock(index) }}
                    onPressOut={() => { if (!drag.current.dragging) lock() }}
                    style={styles.cardInner}
                  >
                    <Text size={11} color={theme['c-font-label']} numberOfLines={1}>{formatFreq(frequencies31[index])}</Text>
                    <Text size={15} color={unlocked ? accent : undefined} style={styles.cardValue}>{`${value > 0 ? '+' : ''}${value.toFixed(1)}`}</Text>
                    <View style={{ ...styles.track, width: trackW, backgroundColor: theme['c-primary-alpha-400'] as string }}>
                      {unlocked && <View style={{
                        position: 'absolute', left: -5, right: -5, top: -6, bottom: -6, borderRadius: 10,
                        backgroundColor: accent, opacity: 0.22,
                      }} />}
                      <View style={{
                        position: 'absolute', left: fillLeft, width: fillWidth, top: 0, bottom: 0,
                        borderRadius: 4, backgroundColor: accent, opacity: unlocked ? 1 : 0.6,
                      }} />
                      <View style={{ ...styles.centerTick, backgroundColor: lineColor }} />
                      <View style={{
                        position: 'absolute', left: clamp(thumbLeft, -3, trackW - 11), top: -4,
                        width: 14, height: 14, borderRadius: 7,
                        borderWidth: 2, borderColor: unlocked ? accent : (theme['c-font-label'] as string),
                        backgroundColor: unlocked ? accent : (theme['c-primary-alpha-900'] as string),
                      }} />
                    </View>
                  </Pressable>
                </View>
              </View>
            )
          })}
        </ScrollView>
      </View>
      <Text size={10} color={theme['c-font-label']} style={styles.lockHint}>
        {dragging
          ? '正在调值 · 松手自动锁回去'
          : `左右滑切换频段 · 长按进度条 ${UNLOCK_MS / 1000}s 解锁${focus >= 0 ? '（已解锁）' : ''}`}
      </Text>
    </View>
  )
}

const styles = createStyle({
  graphWrap: { height: 200, borderRadius: 10, overflow: 'hidden', marginTop: 8 },
  graphBg: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 4, paddingHorizontal: 2 },
  toolRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 6 },
  toolSpacer: { flex: 1 },
  toolBtn: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5, marginRight: 8 },
  carWrap: { marginTop: 8 },
  carContent: { paddingVertical: 4 },
  card: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  cardInner: { paddingHorizontal: 10, paddingTop: 7, paddingBottom: 9, alignItems: 'flex-start' },
  cardValue: { fontWeight: '600', marginTop: 1, marginBottom: 8 },
  track: { height: 8, borderRadius: 4, overflow: 'visible', justifyContent: 'center' },
  centerTick: { position: 'absolute', left: 0, right: 0, height: 1, opacity: 0.35 },
  lockHint: { paddingTop: 6, lineHeight: 15 },
})
