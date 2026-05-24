# Oracle Cloud Always Free Deployment

This deploys Baijia Pro to an Oracle Cloud Always Free Ubuntu VM so recording continues after the local PC and Codex are closed.

## Recommended Free VM

- Provider: Oracle Cloud Infrastructure
- Shape: VM.Standard.A1.Flex
- OS: Ubuntu 24.04 or 22.04
- Size: 2 OCPUs / 12 GB RAM recommended
- Boot volume: 80 GB recommended
- If Oracle reports no capacity, retry with 1 OCPU / 6 GB RAM or another availability domain.

Keep the VM within Oracle Always Free limits. Do not create paid shapes, paid disks, paid load balancers, or extra public IPs unless you intend to pay.

## Oracle Console Steps

1. Create or sign in to Oracle Cloud.
2. Create a Compute Instance.
3. Choose Ubuntu as the image.
4. Choose `VM.Standard.A1.Flex`.
5. Set OCPU and memory within Always Free limits.
6. Add your SSH public key.
7. In the VCN security list or network security group, allow inbound TCP `4173`.

Security note: if possible, restrict TCP `4173` to your own IP address. The dashboard has public read APIs. Manual write APIs still require `API_TOKEN`.

## Install Baijia Pro

SSH into the VM, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/SYLONG7708/Baijia/main/scripts/install-oracle-ubuntu.sh | bash
```

The installer creates:

- App folder: `/opt/baijia`
- Environment file: `/etc/baijia/baijia.env`
- Logs: `/var/log/baijia`
- Systemd service: `baijia-pro`

## Configure Secrets

Edit the environment file on the VM:

```bash
sudo nano /etc/baijia/baijia.env
```

Set at minimum:

```env
ALLBET_URL=https://www.abgame88.net/?hallView=all&loginType=2&language=zh_TW&sessionId=YOUR_SESSION_ID
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_GROUP_CHAT_ID
TELEGRAM_GROUP_NAME=結果群
PUBLIC_API_BASE=http://YOUR_ORACLE_PUBLIC_IP:4173
```

Do not commit `.env` or `/etc/baijia/baijia.env` to GitHub.

Restart after editing:

```bash
sudo systemctl restart baijia-pro
```

## Check Status

```bash
sudo systemctl status baijia-pro --no-pager
curl http://127.0.0.1:4173/api/monitor
```

Live logs:

```bash
sudo journalctl -u baijia-pro -f
```

Open in browser:

```text
http://YOUR_ORACLE_PUBLIC_IP:4173/
```

## Update Later

```bash
cd /opt/baijia
sudo -H -u baijia git pull --ff-only
sudo -H -u baijia npm ci --omit=dev
sudo -H -u baijia npm run build:web
sudo systemctl restart baijia-pro
```

## What Keeps It Running

The systemd service starts `src/daemon.js`, which supervises server, scraper, monitor, trainer, and Telegram notifier. It restarts automatically after crashes and after VM reboot.

The Baijia daemon also has a quality watchdog. If data quality warnings persist, or websocket data stops, it restarts the scraper automatically while avoiding restart loops during external rate limits.
