// 워뇨띠 스타일 1시간봉 분석 → 롱/숏으로 바뀌면 카카오톡 "나에게 보내기" 알림
// GitHub Actions에서 10분마다 실행됩니다. 분석 규칙은 bitgo.html 화면과 같습니다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TF = '1h', HIGHER = '4h';
const NAMES = { LONG: '롱 우위', SHORT: '숏 우위', WAIT: '관망' };
const usd = (n, d = 0) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sma = (arr, n) => (arr.length < n ? null : arr.slice(-n).reduce((s, x) => s + x, 0) / n);

async function getJSON(url, ms = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------- 시세 (바이낸스 → 안 되면 OKX) ---------- */
const SOURCES = [
  { name: 'binance', klines: async (iv, limit) => {
      for (const host of ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com']) {
        try {
          const k = await getJSON(`${host}/api/v3/klines?symbol=BTCUSDT&interval=${iv}&limit=${limit}`);
          return k.map(c => ({ o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
        } catch { /* 다음 주소 시도 */ }
      }
      throw new Error('binance 접속 불가');
  } },
  { name: 'okx', klines: async (iv, limit) => {
      const bar = { '1h': '1H', '4h': '4H' }[iv];
      const d = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${bar}&limit=${limit}`);
      return d.data.slice().reverse().map(c => ({ o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
  } },
];
async function fetchCandles() {
  let lastErr;
  for (const s of SOURCES) {
    try {
      const [cs, hs] = await Promise.all([s.klines(TF, 120), s.klines(HIGHER, 60)]);
      if (cs.length >= 80 && hs.length >= 25) return { source: s.name, cs, hs };
      throw new Error('캔들 수 부족');
    } catch (e) { lastErr = e; console.log(`${s.name} 실패: ${e.message}`); }
  }
  throw new Error('모든 시세 소스 실패: ' + (lastErr ? lastErr.message : ''));
}

/* ---------- 분석 (bitgo.html의 analyzeW와 같은 규칙) ---------- */
export function analyze(cs, hs) {
  const closed = cs.slice(0, -1), live = cs[cs.length - 1];
  const last = closed[closed.length - 1], prev20 = closed.slice(-21, -1);
  const reasons = []; let score = 0;
  const add = (p, t) => { score += p; reasons.push({ p, t }); };

  const hi20 = Math.max(...prev20.map(c => c.h)), lo20 = Math.min(...prev20.map(c => c.l));
  if (last.c > hi20) add(2, `20봉 고점 돌파`);
  else if (last.c < lo20) add(-2, `20봉 저점 이탈`);

  const ups = closed.slice(-3).filter(c => c.c > c.o).length;
  if (ups === 3) add(1, '3봉 연속 양봉');
  else if (ups === 0) add(-1, '3봉 연속 음봉');

  const range = last.h - last.l || 1, body = Math.abs(last.c - last.o);
  const upW = last.h - Math.max(last.c, last.o), loW = Math.min(last.c, last.o) - last.l;
  if (body / range >= 0.6) add(last.c > last.o ? 1 : -1, last.c > last.o ? '장대양봉' : '장대음봉');
  if (loW / range >= 0.5 && loW > body * 2) add(1, '긴 아랫꼬리');
  if (upW / range >= 0.5 && upW > body * 2) add(-1, '긴 윗꼬리');

  const closes = closed.map(c => c.c), ma20 = sma(closes, 20), ma60 = sma(closes, 60);
  if (ma20 && ma60) {
    if (last.c > ma20 && ma20 > ma60) add(1, '이평 정배열');
    else if (last.c < ma20 && ma20 < ma60) add(-1, '이평 역배열');
  }

  const hMa = sma(hs.slice(0, -1).map(c => c.c), 20), hLast = hs[hs.length - 1].c;
  if (hMa) add(hLast > hMa ? 1 : -1, hLast > hMa ? '4시간봉 상승 추세' : '4시간봉 하락 추세');

  const vAvg = sma(prev20.map(c => c.v), 20), vRatio = vAvg ? last.v / vAvg : 1;
  let cat = 'WAIT';
  if (score >= 3 && vRatio >= 1) cat = 'LONG';
  else if (score <= -3 && vRatio >= 1) cat = 'SHORT';
  return { score, reasons, vRatio, cat, price: live.c };
}

/* ---------- 카카오톡 ---------- */
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' };
async function kakaoRefresh(env) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.KAKAO_REST_API_KEY, refresh_token: env.KAKAO_REFRESH_TOKEN });
  if (env.KAKAO_CLIENT_SECRET) body.set('client_secret', env.KAKAO_CLIENT_SECRET);
  const r = await fetch('https://kauth.kakao.com/oauth/token', { method: 'POST', headers: FORM, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`카카오 토큰 갱신 실패 (${r.status}) ${d.error || ''} ${d.error_description || ''}`.trim());
  return d; // 갱신 토큰이 30일 이내로 남았을 때만 d.refresh_token이 함께 옵니다
}
async function kakaoSend(accessToken, text, env) {
  const url = env.DASHBOARD_URL || 'https://minhwa-park.github.io/bitgo/bitgo.html';
  const tpl = { object_type: 'text', text: text.slice(0, 200), link: { web_url: url, mobile_web_url: url }, button_title: '대시보드 열기' };
  const r = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST', headers: { ...FORM, Authorization: 'Bearer ' + accessToken },
    body: new URLSearchParams({ template_object: JSON.stringify(tpl) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.result_code !== 0) throw new Error(`카카오 전송 실패 (${r.status}) ${d.msg || ''}`.trim());
}

export function buildMessage(r, prev) {
  const head = `[워뇨띠 스타일] 1시간봉 ${NAMES[prev] || '-'} → ${NAMES[r.cat]}\n점수 ${r.score > 0 ? '+' : ''}${r.score} · BTC ${usd(r.price)} · 거래량 ${r.vRatio.toFixed(1)}배`;
  const foot = '※ 단순 규칙 시뮬레이션, 투자 권유 아님';
  const room = 200 - head.length - foot.length - 2;
  const why = r.reasons.map(x => `${x.p > 0 ? '+' : ''}${x.p} ${x.t}`).join(' · ').slice(0, Math.max(room, 0));
  return `${head}\n${why}\n${foot}`;
}

/* ---------- 상태 파일 ---------- */
const readState = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } };
const writeState = (p, s) => fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);

export async function main(env = process.env) {
  const statePath = env.STATE_PATH || path.join(HERE, 'state.json');
  const test = env.TEST_MODE === 'true';
  const state = readState(statePath);
  const today = new Date().toISOString().slice(0, 10);

  const { source, cs, hs } = await fetchCandles();
  const r = analyze(cs, hs);
  console.log(`[${source}] 1시간봉 판정=${r.cat} 점수=${r.score} 거래량=${r.vRatio.toFixed(2)}배 (이전=${state.verdict ?? '없음'})`);

  const prev = state.verdict;
  const comparable = prev !== undefined && state.source === source; // 소스가 바뀐 직후엔 알림 생략
  const shouldAlert = comparable && r.cat !== prev && (r.cat === 'LONG' || r.cat === 'SHORT');
  const tokenDue = state.lastTokenCheck !== today;

  const next = { ...state, verdict: r.cat, source };
  if (test || shouldAlert || tokenDue) {
    if (!env.KAKAO_REST_API_KEY || !env.KAKAO_REFRESH_TOKEN) throw new Error('KAKAO_REST_API_KEY / KAKAO_REFRESH_TOKEN 비밀값이 없습니다');
    const t = await kakaoRefresh(env);
    next.lastTokenCheck = today;
    if (test) await kakaoSend(t.access_token, '✅ 알림 테스트: 카카오톡 연결이 정상입니다.\n워뇨띠 스타일 1시간봉이 롱/숏으로 바뀌면 이렇게 알려 드립니다.', env);
    if (shouldAlert) { await kakaoSend(t.access_token, buildMessage(r, prev), env); console.log('카카오톡 알림 전송 완료'); }
    if (t.refresh_token && (!state.lastTokenWarn || daysBetween(state.lastTokenWarn, today) >= 3)) {
      await kakaoSend(t.access_token, '⚠️ 카카오 갱신 토큰 만료가 30일 이내입니다.\n알림이 멈추기 전에 토큰을 다시 발급해 GitHub Secrets의 KAKAO_REFRESH_TOKEN을 바꿔 주세요.', env);
      next.lastTokenWarn = today;
    }
  }
  writeState(statePath, next); // 전송까지 성공했을 때만 저장 → 실패하면 다음 실행에서 다시 시도
  return { r, next, shouldAlert };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('오류:', e.message); process.exit(1); });
}
