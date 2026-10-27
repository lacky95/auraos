.PHONY: aura-base up down restart logs ps

## aura-base — build the sibling-container image that ContainerRunner spawns
## from (the `aura-base` stage of the Dockerfile). `docker compose up` builds
## it too (build-only `aura-base` service), so this target is only a shortcut.
## Re-run it whenever you change that stage.
aura-base:
	docker compose build aura-base

## up — bring AuraOS up; compose builds aura-base first (depends_on).
up:
	docker compose up -d --build aura-os

down:
	docker compose down

restart:
	docker compose restart aura-os

logs:
	docker compose logs -f aura-os

ps:
	docker ps --filter 'name=aura-' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
