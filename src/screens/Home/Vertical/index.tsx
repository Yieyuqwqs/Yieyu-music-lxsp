import Content from './Content'
import PlayerBar from '@/components/player/PlayerBar'
import UndoBar from '@/components/common/UndoBar'

export default () => {
  return (
    <>
      <Content />
      <PlayerBar isHome />
      <UndoBar />
    </>
  )
}
