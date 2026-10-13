# 口径对齐验证 · 数据采集端（同源 K 线落盘，支持断点续传）
# python train/parity_fetch.py
import urllib.request, json, time, os

SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'APTUSDT',
        'BLURUSDT', 'SUIUSDT', 'ARBUSDT', 'INJUSDT', 'PEPEUSDT', 'FILUSDT']
PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parity_klines.json')

def get(url, tries=10):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'parity'})
            return json.load(urllib.request.urlopen(req, timeout=25))
        except Exception:
            time.sleep(2 + t)
    return None

out = json.load(open(PATH)) if os.path.exists(PATH) else {}
for s in SYMS:
    if s in out:
        continue
    ks = get(f'https://fapi.binance.com/fapi/v1/klines?symbol={s}&interval=1h&limit=120')
    pi = get(f'https://fapi.binance.com/fapi/v1/premiumIndex?symbol={s}')
    if ks and pi:
        out[s] = {'fr': float(pi['lastFundingRate']),
                  'ohlcv': [[float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in ks]}
        json.dump(out, open(PATH, 'w'), separators=(',', ':'))
        print('done', s)
    else:
        print('SKIP', s)
print('total', len(out), '/', len(SYMS))
