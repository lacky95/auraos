.PHONY: aura-base up down restart logs ps

## aura-base — build the sibling-container image that ContainerRunner spawns
## from. We reuse the existing `base-rootfs` stage from the main Dockerfile
## so there's exactly one definition of "what's in a fresh AuraOS sandbox".
## Re-run this whenever you change the base-rootfs apt list.
aura-base:
	docker build -t aura-base -f Dockerfile --target aura-base .

## up — bring AuraOS up (depends on aura-base for sandbox: 'container' apps).
up: aura-base
	docker compose up -d --build aura-os

down:
	docker compose down

restart:
	docker compose restart aura-os

logs:
	docker compose logs -f aura-os

ps:
	docker ps --filter 'name=aura-' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
