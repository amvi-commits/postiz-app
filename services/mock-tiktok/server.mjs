import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const key = fs.readFileSync(path.join(__dirname, 'key.pem'));
const cert = fs.readFileSync(path.join(__dirname, 'cert.pem'));

const server = https.createServer({ key, cert }, (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host || 'open.tiktokapis.com'}`);
  console.log(`[mock-tiktok] ${req.method} ${url.pathname}`);

  if (url.pathname === '/v2/post/publish/creator_info/query/' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log('[mock-tiktok] creator_info query received');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          creator_avatar_url: 'https://sns-studio.sweet-honey-works.com/icons/platforms/tiktok.png',
          creator_username: 'reviewer_demo',
          creator_nickname: 'TikTok Reviewer',
          privacy_level_options: [
            'PUBLIC_TO_EVERYONE',
            'MUTUAL_FOLLOW_FRIENDS',
            'FOLLOWER_OF_CREATOR',
            'SELF_ONLY'
          ],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: 600
        },
        error: {
          code: 'ok',
          message: ''
        }
      }));
    });
    return;
  }

  // All other endpoints fail closed!
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      code: 'fail_closed_guard',
      message: 'TikTok external actions are strictly disabled in review runtime'
    }
  }));
});

server.listen(443, '0.0.0.0', () => {
  console.log('[mock-tiktok] Listening on port 443 (open.tiktokapis.com mock)');
});
