# Extension Self-Hosting Guide

Roll Together only needs two backend URLs:

- an HTTP base URL
- a matching WebSocket URL that ends in `/ws`

If you are new to self-hosting, the easiest way to think about it is:

1. pick where the backend will run
2. give it a reachable address
3. put those two URLs into the extension settings

If you want the full backend deployment steps, use the backend repository guide:

- [Backend self-hosting guide](https://github.com/punkrock34/roll_together_backend/blob/main/docs/self-hosting.md)

## Pick a Hosting Path

### Option 1: Small VPS

This is the easiest stable setup if you plan to host often.

Good fit if:

- you want the room server online whenever you need it
- you want the cleanest setup for friends outside your home
- you do not want to deal with router port forwarding

Typical examples:

- a small Linux VPS from a provider such as Hetzner
- a subdomain such as `watch.example.com`

## Option 2: Spare Laptop, Raspberry Pi, or Mini PC

This is the cheapest long-term setup if you already own the hardware.

Good fit if:

- you have an old laptop, Raspberry Pi, mini PC, or desktop sitting around
- you do not mind keeping that machine powered on when you host
- you are comfortable doing either router port forwarding or using a tunnel

For home hosting, a Dynamic DNS hostname can be enough if you do not want to buy a domain yet.

## Option 3: Your Current PC

This is the easiest temporary setup for testing or occasional sessions.

Good fit if:

- you only host once in a while
- you do not want to leave another machine running
- you understand the backend must be started every time you want to host

If your PC goes to sleep, reboots, or closes Docker, the room backend is offline until you start it again.

## Domain or Hostname

The best long-term setup is a normal domain or subdomain:

- `https://watch.example.com`
- `wss://watch.example.com/ws`

If you do not want to buy a domain yet, a Dynamic DNS hostname can also work for home setups. A free Dynamic DNS hostname is usually easier than trying to chase free domain offers.

## What to Put in the Extension

### Public HTTPS setup

```text
HTTP Base URL: https://watch.example.com
WebSocket URL: wss://watch.example.com/ws
```

### Local-only setup

```text
HTTP Base URL: http://localhost:3000
WebSocket URL: ws://localhost:3000/ws
```

### Custom host port

If you publish the backend on a different host port, change only the visible host port:

```text
HTTP Base URL: http://localhost:11420
WebSocket URL: ws://localhost:11420/ws
```

## Recommended Beginner Path

If you just want the least painful setup for regular use:

1. get a small Ubuntu VPS
2. point a domain or subdomain at it
3. run the backend with Docker
4. put Nginx, Apache, or another HTTPS-capable frontend in front of it
5. enter `https://your-domain` and `wss://your-domain/ws` in the extension

If you want the cheapest path and already own hardware:

1. use a spare laptop, Raspberry Pi, or mini PC
2. keep it on whenever you want friends to connect
3. use either a domain plus port forwarding, or a Dynamic DNS hostname, or a tunnel
4. enter the matching HTTP and WebSocket URLs in the extension

## Where to Change the URLs

You can change backend URLs in two places:

- the popup `Settings` tab
- the full extension settings page

The full settings page is better for maintenance because it also shows saved rooms and watched progress.
