import { createServer } from 'node:http'
const greeting = process.env.GREETING ?? 'hello'
createServer((req, res) => {
  if (req.url === '/healthz') return res.end('ok')
  res.setHeader('content-type', 'text/plain')
  res.end(`${greeting} from fixture-app (built __BUILT__, secret set: ${Boolean(process.env.API_TOKEN)})\n`)
}).listen(Number(process.env.PORT), process.env.HOST)
