# 🌐 Web Proxy — apna custom proxy lagao

Jo website kholo ge, request tumhare diye hue proxy se jayegi.

## Chalane ka tareeqa (Windows)

1. **Node.js** install karo (agar nahi hai): https://nodejs.org — "LTS" wala button.
2. Is zip ko extract karo (kahin bhi, misal: `Documents\web-proxy`).
3. **`start.bat`** par double-click karo.
4. Browser me kholo: **http://localhost:8080**

(Band karne ke liye kaali window close kar do.)

## Istemal

1. Protocol chuno (HTTP / HTTPS / SOCKS5), proxy ka **host, port, username, password** likho.
2. **"Proxy lagao"** dabao — proxy test ho kar connect ho jayega.
3. Website ka URL likho → **"Kholo"**.
4. Har khuli hui site ke neeche ek chhoti **proxy bar** hogi — wahan se nayi site khol sakte ho.
5. **"Mera IP check karo"** se tasdeeq karo ke IP tumhare proxy wala aa raha hai.

## Public link (phone/doosri device se kholne ke liye)

Koi account ya card nahi chahiye:

1. `start.bat` se server chal raha ho (kaali window khuli ho).
2. **cloudflared** download karo: https://github.com/cloudflare/cloudflared/releases — `cloudflared-windows-amd64.exe` wali file lo, is folder me rakh kar naam **`cloudflared.exe`** kar do.
3. **`tunnel.bat`** chalao — ek public link milega, jaise `https://xxx.trycloudflare.com`.
4. Ye link phone par kholo — proxy site wahan chalegi.

Note: PC aur dono windows on rehni chahiye. Link har bar naya banta hai (fix link ke liye free Cloudflare account se `cloudflared tunnel` login karna parta hai — optional).

## Zaroori baatein

- 🔒 Proxy ki details **kahin save nahi hotin** — sirf session ki memory me rehti hain. 45 minute kuch na karo to session khatam.
- ⚠️ Ye sirf **browser-traffic** ke liye hai — kisi app ka traffic is se nahi guzrega.
- Kuch sites (bank, Cloudflare-protected) proxy IPs ko block karti hain — wo nahi khulengi to ye normal hai.
- Bina proxy ke test karna ho to "Proxy ke baghair seedha connect" tick kar do.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jowaltoai-afk/web-proxy)
