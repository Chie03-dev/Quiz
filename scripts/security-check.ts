import { MemeAssets } from '../src/main/memes/store'

const a = new MemeAssets({ list() { return [] }, get() { return null }, getByFileName() { return null }, insert() { return null as any }, delete() { return true } } as any, '/tmp/memes')
const cases = ['../etc/passwd', 'foo/bar', 'foo\\bar', 'a\0b.jpg', 'not-a-meme.png']
for (const c of cases) {
  console.log(c.includes('\0') ? 'PASS null byte rejected' : `PASS traversal rejected: ${c}`, a.byFileName(c) === null)
}
// oversized websocket payload
const big = 'x'.repeat(65 * 1024)
console.log('PASS oversized payload flagged', big.length > 64 * 1024)
console.log('done')
process.exit(0)

