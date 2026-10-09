# DevOps Webapp: Feature Flags on Kubernetes

[![CI](https://github.com/Nanikss/devops-webapp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nanikss/devops-webapp/actions/workflows/ci.yml)

A small feature-flag service, packaged as a hardened container and deployed to Kubernetes with Kustomize. The app is deliberately small. The point of the project is the deployment around it: probes, zero-downtime rollouts, autoscaling, disruption budgets, a locked-down security context, config mounted from a ConfigMap, per-environment overlays, and a CI pipeline that tests all of it on a real (throwaway) cluster.

**Stack:** Node.js · Express · prom-client · Docker · Kubernetes · Kustomize · kind · GitHub Actions · GHCR

## History

I started this repo in 2025 while learning Docker. It was an Express "hello" app, a Dockerfile, and a script and workflow that built an image and pushed it to Docker Hub on every commit. That taught me the basics of images and registries, but nothing about running something in production.

In 2026 I rebuilt it as a Kubernetes deployment project. I kept the history and replaced the hello app with a service that has a little real behaviour (state, config, validation) so the deployment choices have something to protect.

## What the service does

| Endpoint | Purpose |
| --- | --- |
| `GET /api/flags` | list all flags |
| `GET /api/flags/:key` | one flag, or 404 |
| `PUT /api/flags/:key` | create or update: `{"enabled": true, "rolloutPercent": 25}` (validated, 400 with details) |
| `GET /api/flags/:key/evaluate?userId=u-42` | is this flag on for this user? |
| `GET /healthz` | liveness: the process is up |
| `GET /readyz` | readiness: 503 once shutdown has started |
| `GET /version` | the `APP_VERSION` baked into the image (the commit SHA in CI) |
| `GET /metrics` | Prometheus: default Node metrics, `http_request_duration_seconds` histogram, `flag_evaluations_total` |

**Percentage rollout** is deterministic: `sha256(flagKey + ":" + userId)` maps each user to a bucket 0-99, and the flag is on when `bucket < rolloutPercent`. The same user always gets the same answer on every pod, raising the percentage only adds users (nobody flips off), and each flag rolls out to a different slice of users.

Flags are seeded from a JSON file whose path comes from `FLAGS_FILE`. In Kubernetes that file is a ConfigMap mounted as a read-only volume. A missing or invalid file fails startup with a clear JSON log line, so a bad config shows up as a failed rollout instead of a pod serving wrong flags. `PUT` changes are in memory and per pod; the ConfigMap is the source of truth (see "What I'd do next").

Logs are one JSON object per line on stdout. On `SIGTERM` the server marks itself not ready, keeps serving for `SHUTDOWN_DELAY_MS`, then stops accepting connections and lets in-flight requests finish.

## Architecture

```
GitHub push ──► CI: test ─► image (build, smoke test, push to GHCR)
                     └────► manifests (kustomize build + kubeconform) ─► kind (deploy, upgrade, rollback)

                     Ingress (nginx, flags.example.com)
                        │
                     Service feature-flags (ClusterIP :80)
                        │
        ┌───────────────┼───────────────┐
      Pod             Pod             Pod        ◄── Deployment (RollingUpdate, maxUnavailable 0)
   node:20-alpine, uid 1000, read-only root FS       HPA: CPU 70%   PDB: minAvailable 1
        │
   /etc/feature-flags/flags.json  ◄── ConfigMap feature-flags-config-<hash>
```

## Kubernetes design choices

- **Three probes, three jobs.** The startup probe (`/healthz`, up to 60s) protects slow starts. After that the liveness probe (`/healthz`) restarts a hung process, and the readiness probe (`/readyz`) decides whether the pod gets traffic. Liveness checks nothing external, so an outage somewhere else never causes a restart storm.
- **Zero-downtime rollouts.** `maxUnavailable: 0` and `maxSurge: 1` mean a new pod has to be Ready before an old one goes away. On shutdown the app fails readiness first and waits 5 seconds before closing, so endpoints and the ingress stop routing to it before it stops listening.
- **HPA and PDB together.** The HPA scales on CPU (70% of the request, with a 5-minute scale-down window so it doesn't flap). The PodDisruptionBudget (`minAvailable: 1`) stops node drains and cluster upgrades from evicting every pod at once. Dev runs one replica, so the dev overlay deletes the PDB; otherwise every drain would block.
- **Locked-down pods.** `runAsNonRoot` with uid 1000, `readOnlyRootFilesystem`, all Linux capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp, and no service account token mounted (the app never calls the API server). The only writable path is a small `emptyDir` on `/tmp`. In the image, the code is owned by root, so the app user can't change it.
- **Config from a ConfigMap, rolled out like code.** `configMapGenerator` adds a content hash to the ConfigMap name. Changing `flags.json` changes the pod template, so a config change goes through the same rolling update, probes and rollback as an image change. There's no "edited the ConfigMap and nothing happened" moment.
- **Kustomize overlays.** `base/` has everything shared, with no namespace. `overlays/dev` gives one replica, namespace `flags-dev` and image tag `dev`. `overlays/prod` gives three replicas (HPA 3-10), namespace `flags-prod`, higher requests and limits, and its own more conservative `flags.json`. Prod has no usable default tag: `scripts/deploy.sh` sets an immutable commit-SHA tag and refuses `latest`.
- **Requests and limits** are set on every container, so the scheduler can place pods properly and the HPA has a baseline to measure against. The topology spread constraint keeps replicas on different nodes where possible.

## Run it

**Locally (Node 16+):**

```bash
npm install
npm start                                   # http://localhost:3000, flags from config/flags.json
curl localhost:3000/api/flags
curl "localhost:3000/api/flags/new-quote-flow/evaluate?userId=u-42"
curl -X PUT localhost:3000/api/flags/beta -H 'content-type: application/json' \
     -d '{"enabled": true, "rolloutPercent": 10}'
```

**Docker:**

```bash
docker build --build-arg APP_VERSION=local -t devops-webapp .
docker run --rm -p 3000:3000 --read-only --tmpfs /tmp devops-webapp
```

**Kubernetes on kind** (needs docker, kind and kubectl):

```bash
scripts/kind-up.sh                          # cluster + image + dev overlay + port-forward on :8080
curl localhost:8080/version
kind delete cluster --name flags            # clean up
```

**Deploying to a real cluster** (uses your current kubectl context, needs kustomize):

```bash
scripts/deploy.sh prod 1a2b3c4              # apply overlay with that image tag, wait for the rollout
scripts/deploy.sh prod --rollback           # kubectl rollout undo + wait
```

`deploy.sh` sets the image tag in a temporary copy of `k8s/` (`kustomize edit set image`), runs `kubectl apply -k`, and waits on `kubectl rollout status` with a timeout. If the rollout doesn't finish in time, it prints the pods and rolls back automatically (`AUTO_ROLLBACK=false` turns that off).

## CI

`.github/workflows/ci.yml` runs on pushes to `master` and on pull requests:

1. **test**: `npm ci` and `npm test` on Node 20.
2. **image**: Buildx build with `APP_VERSION` set to the short SHA. Then it runs the container with `--read-only`, checks `/healthz`, `/readyz`, `/version`, `/api/flags` and `/metrics`, confirms it runs as the `node` user, and runs the HEALTHCHECK script. On `master` it logs in to GHCR with `GITHUB_TOKEN` and pushes `ghcr.io/<owner>/devops-webapp:<sha>` and `:latest`.
3. **manifests**: renders both overlays with kustomize and validates them with `kubeconform -strict`, checks the differences each overlay is supposed to make, and uploads the rendered YAML as an artifact.
4. **kind**: end to end on a throwaway kind cluster. It builds two image versions, deploys the first with `scripts/deploy.sh`, and smoke tests through the Service. It also checks that the API server really applied the read-only root FS, upgrades to the second version, rolls back, and checks that `/version` is the first version again.

## Tests

```bash
npm test        # 37 tests (jest + supertest)
```

The tests cover:

- flag validation
- flags CRUD and 400/404 handling, including malformed JSON
- evaluation: deterministic; 0% enables nobody, 100% enables everybody, 50% gives about half of 1000 users; raising the percentage never removes users
- `FLAGS_FILE` loading and its error cases, plus validation of every shipped flags file (local config, base ConfigMap and prod ConfigMap)
- health, readiness and version
- a real server start: shutdown makes `/readyz` 503 while requests still succeed, then the server closes
- `/metrics` exposing the request histogram

## Layout

```
src/server.js          startup, FLAGS_FILE loading, graceful SIGTERM shutdown
src/app.js             Express routes, request metrics, JSON access logs, error handling
src/flags.js           flag store, validation, deterministic rollout hashing, file loader
src/metrics.js         prom-client registry, request histogram, evaluation counter
src/logger.js          JSON line logger
src/healthcheck.js     Docker HEALTHCHECK probe
config/flags.json      default flags baked into the image (local and Docker runs)
k8s/base/              Deployment, Service, HPA, PDB, Ingress, ConfigMap generator + flags.json
k8s/overlays/dev/      1 replica, flags-dev, tag "dev", no PDB
k8s/overlays/prod/     3 replicas, flags-prod, bigger limits, prod flags.json
scripts/deploy.sh      deploy an overlay with an image tag, wait, auto-rollback, --rollback
scripts/kind-up.sh     local kind cluster demo
test/                  jest + supertest
Dockerfile             multi-stage, node:20-alpine, npm ci --omit=dev, non-root, HEALTHCHECK
```

## Interview notes

- **Liveness vs readiness vs startup.** Readiness failing takes the pod out of the Service but leaves it running. Use it for "not right now" (starting up, shutting down, overloaded). Liveness failing restarts the container, so it should only catch a truly stuck process and never depend on a database or another service. The startup probe holds off the other two until the app has started, so a slow start isn't killed by liveness.
- **Why `maxUnavailable: 0` plus a PDB.** They protect against different things. The rollout strategy covers *my* changes: never fewer ready pods than desired during a deploy. The PDB covers *the cluster's* changes, like node drains, autoscaler scale-downs and upgrades, which go through the eviction API and respect `minAvailable`. Neither helps if the pods don't handle SIGTERM properly, which is why the app fails readiness before it closes.
- **readOnlyRootFilesystem.** If someone gets code execution in the container, they can't drop binaries, change the app or tamper with files. It also forces the app to be honest about what it writes. Here that's nothing except `/tmp`, which is an explicit `emptyDir` with a size limit.
- **Rollback.** Every change, image or config, creates a new ReplicaSet, so `kubectl rollout undo` (or `scripts/deploy.sh <env> --rollback`) returns to the previous pod template, including the previous hashed ConfigMap. The deploy script also rolls back on its own if `rollout status` times out, and CI tests the upgrade-then-rollback path on kind.
- **What I'd do next.** Package it as a Helm chart, or keep Kustomize and let Argo CD sync the overlays from Git (GitOps), so deploys become pull requests and drift gets reverted. Move flag writes to a real store (Redis or Postgres) so all replicas agree, and put authentication in front of `PUT`. Use External Secrets for any credentials that come with that. Add a ServiceMonitor and alerts on the latency histogram and error rate.

Built with AI coding tools; I designed the deployment setup and Kubernetes configuration, and reviewed and tested the code.
