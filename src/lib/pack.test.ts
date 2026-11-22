/// <reference types="node" />
// 确定性打包（scripts/lib/pack.mjs）的护栏：同一份输入连打两次必须同字节。
//
// ★为什么这条重要（2026-11-22 三审）：`npm run package` 声称「可复现」，但 1.37.0 的做法
//   是调平台自带的 `tar` —— 在 CI（Linux/GNU tar）上成立，在 **Windows 上不成立**：
//   · 系统自带 bsdtar 的 gzip 头写本次打包的真实时刻，`--mtime` 钉不住压缩层（两次
//     sha256 `890c233c…` ≠ `e3aa13ba…`，裸 tar 流却完全相同 `877dd241…`）；
//   · 它也没有 `--mode`，产物权限位跟着 umask 走（Windows 0666/0777、CI 0644/0755）。
//   改成 tar + gzip 两层都在 Node 里写之后，这两个漂移源都消失。这条测试钉住它：
//   一旦有人把固定 mtime / 属主 / 排序 / gzip 头的写法改回去，这里当场红。
//
// 另外断「包能解开、条目在、权限位是 0644/0755、属主 0、mtime 0」——这些正是 hub 解包
// 时依赖的形状（monitor v1.5.2 的 unpack 只认普通文件 / 目录 + gzip 魔数）。
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { listArchive, packDirectory } from "../../scripts/lib/pack.mjs"

const root = mkdtempSync(join(tmpdir(), "jikasei-pack-"))
try {
  // 造一个最小但结构完整的主题目录：一个文件、一个子目录、一个子文件。
  mkdirSync(join(root, "src", "dist"), { recursive: true })
  mkdirSync(join(root, "src", "dist", "assets"), { recursive: true })
  writeFileSync(join(root, "src", "theme.json"), JSON.stringify({ short: "x", version: "0.0.0" }))
  writeFileSync(join(root, "src", "dist", "index.html"), "<!doctype html><title>x</title>")
  writeFileSync(join(root, "src", "dist", "assets", "a.js"), "export const a = 1\n")
  const files = ["theme.json", "dist"]

  const first = packDirectory(join(root, "src"), join(root, "a.tar.gz"), { files })
  // 中间停一下：真实场景里两次打包至少隔几秒 —— 若 mtime / gzip 头还跟着真实时间走，
  // 这里就会像 Windows 上那样漂开（旧实现的实测差值 11 秒）。
  const wait = Date.now() + 1100
  while (Date.now() < wait) { /* 真实等待，不屏蔽时间依赖 */ }
  const second = packDirectory(join(root, "src"), join(root, "b.tar.gz"), { files })

  assert.equal(first.digest, second.digest, "同一份输入连打两次必须同 sha256")
  assert.ok(readFileSync(join(root, "a.tar.gz")).equals(readFileSync(join(root, "b.tar.gz"))), "两次产物必须逐字节相同")
  console.log("PASS  同一份输入连打两次：同 sha256、逐字节相同")

  // gzip 头：MTIME 钉 0、OS=03（与 CI 的 gzip 一致）、无 FNAME/FEXTRA 之类的可选字段。
  const gz = readFileSync(join(root, "a.tar.gz"))
  assert.equal(gz[0], 0x1f)
  assert.equal(gz[1], 0x8b)
  assert.equal(gz[2], 0x08, "压缩方法必须是 deflate")
  assert.equal(gz[3], 0x00, "gzip FLG 不许带 FNAME/FEXTRA/FCOMMENT（它们会让产物随文件名漂）")
  assert.equal(gz.readUInt32LE(4), 0, "gzip 头 MTIME 必须是 0")
  assert.equal(gz[9], 0x03, "gzip 头 OS 必须是 03（Unix），跨平台同字节")
  console.log("PASS  gzip 头：MTIME 0、FLG 0、OS 03")

  // 解回来：条目齐全、顺序按字节序、权限位与属主符合 CI 的检出形状。
  const names = listArchive(join(root, "a.tar.gz")).map((entry) => entry.name)
  assert.deepEqual(names, ["theme.json", "dist/", "dist/assets/", "dist/assets/a.js", "dist/index.html"])
  console.log("PASS  条目与顺序：按名字的字节序，目录带尾斜杠")

  const raw = gunzipSync(gz)
  const read = (offset: number, from: number, to: number) => raw.subarray(offset + from, offset + to).toString("latin1")
  const entryModes = []
  for (let offset = 0; offset + 512 <= raw.length; ) {
    const head = raw.subarray(offset, offset + 512)
    if (head.every((byte) => byte === 0)) break
    const size = parseInt(read(offset, 124, 136).replace(/\0.*$/s, "").trim() || "0", 8)
    const isDir = head[156] === 0x35
    entryModes.push({ mode: read(offset, 100, 108).replace(/\0.*$/s, "").trim(), uid: read(offset, 108, 116).replace(/\0.*$/s, "").trim(), mtime: read(offset, 136, 148).replace(/\0.*$/s, "").trim(), isDir })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  for (const entry of entryModes) {
    assert.equal(parseInt(entry.mode, 8), entry.isDir ? 0o755 : 0o644, `权限位必须是 ${entry.isDir ? "755" : "644"}（与 CI 的 git 检出同形）`)
    assert.equal(parseInt(entry.uid, 8), 0, "属主必须是 0（不写这台机器的 uid）")
    assert.equal(parseInt(entry.mtime, 8), 0, "tar 成员的 mtime 必须是 0")
  }
  console.log(`PASS  ${entryModes.length} 个条目的权限位 / 属主 / mtime 都钉死`)

  // 结尾：两个全零块 + 补到 10240 的整数倍（与 GNU tar 的 blocking factor 20 一致）。
  assert.equal(raw.length % 10240, 0, "裸 tar 必须是 10240 的整数倍")
  console.log("PASS  裸 tar 补到 10240 的整数倍")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("\n打包可复现：全部通过")
