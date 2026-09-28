// 部署前的本机验收：静态文件走本地 dist/（就是待发的那份构建产物），/api/* 转给真 hub。
//
// 用法：node tools/pre_deploy_check.mjs <上游 hub 地址> [节点id]
//   例：ssh -N -L 28081:127.0.0.1:28080 <那台机器> &
//       node tools/pre_deploy_check.mjs http://127.0.0.1:28081 3
//
// 为什么要它：直接对着线上验，验到的是**已经发上去的那版**；对着桩数据验，又跑不出图表相关
// 的结论（桩里历史数据是空的）。这里把两半拼起来——本机伺服待发的 dist、真 hub 供数据——
// 于是「新构建 + 真实数据」能在碰线上之前先跑一遍。
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM = process.argv[2]
const NODE_ID = process.argv[3] || ''
if (!UPSTREAM) { console.error('用法：node tools/pre_deploy_check.mjs <上游 hub 地址> [节点id]'); process.exit(2) }

const PORT = 5300 + Math.floor(Math.random() * 300)
const server = spawn('node', ['tools/serve.mjs', String(PORT), '{}', '', UPSTREAM], { stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })

const base = `http://127.0.0.1:${PORT}`
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await sleep(300)
  try { up = (await fetch(`${base}/api/nodes`)).ok } catch { /* 等它起来 */ }
}
if (!up) { console.error('本地伺服没起来：\n' + serverLog); server.kill(); process.exit(2) }
console.log(`本地伺服装好：${base}（静态 = 本机 dist/，/api/* → ${UPSTREAM}）\n`)

const guard = spawn('node', ['tools/verify_latency_range.mjs', base, 'shots/latency-range-local', NODE_ID], { stdio: ['ignore', 'inherit', 'inherit'] })
const code = await new Promise((r) => guard.on('exit', (c) => r(c ?? 1)))
server.kill()
console.log(`\n本地伺服日志：${serverLog.trim().split('\n').join(' / ')}`)
process.exit(code)
