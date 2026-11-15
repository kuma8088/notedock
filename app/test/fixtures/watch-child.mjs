// 起動元の見張りのテスト用。argv[2]=目印のファイル、argv[3]==='nowatch' なら見張らない。
import fs from 'node:fs'

import { watchParent } from '../../server/platform.mjs'

const marker = process.argv[2]
if (process.argv[3] === 'nowatch') {
  setInterval(() => {}, 1000)
} else {
  watchParent(
    () => {
      fs.writeFileSync(marker, 'gone')
      process.exit(0)
    },
    { intervalMs: 200 },
  )
  setInterval(() => {}, 1000)
}
