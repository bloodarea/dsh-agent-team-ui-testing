import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Serve only this example, independently of the caller's working directory.
const rawPort = process.argv[2] ?? '8199';
if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
  console.error('端口须为 0–65535 的整数；0 表示自动选择空闲端口。');
  process.exit(1);
}
const page = await readFile(new URL('./index.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }
  const path = (request.url ?? '').split('?')[0];
  if (path !== '/' && path !== '/index.html') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : '未找到页面');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': page.length,
    'cache-control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : page);
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && Number(rawPort) !== 0 && !server.listening) {
    console.log('指定端口已被占用，自动选择其他空闲端口。');
    server.listen(0, '127.0.0.1');
    return;
  }
  console.error('启动失败：' + error.message);
  process.exitCode = 1;
});
server.on('listening', () => {
  console.log(`订单查询演示页：http://127.0.0.1:${server.address().port}/index.html`);
  console.log('仅在本机提供演示页；关闭终端或按 Ctrl+C 停止。');
});
server.listen(Number(rawPort), '127.0.0.1');
