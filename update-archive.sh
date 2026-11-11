#!/usr/bin/env bash
# 放在 /home/wsgfai/update-archive.sh；首次克隆，后续拉取更新并启动容器。
set -Eeuo pipefail
umask 077

BASE_DIR=${BASE_DIR:-/home/wsgfai}
APP_DIR=${APP_DIR:-$BASE_DIR/f}
BRANCH=${BRANCH:-main}
PROJECT=archive-ledger
HTTP_PORT=${HTTP_PORT:-8080}
PUBLIC_URL=${PUBLIC_URL:-}
GITHUB_URL=https://github.com/haonanhu02-jpg/f.git
MIRROR_URL=https://gitclone.com/github.com/haonanhu02-jpg/f.git
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
RETRIES=${RETRIES:-3}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}
export GIT_TERMINAL_PROMPT=0

[[ -d $BASE_DIR ]] || { echo "启动目录不存在：$BASE_DIR"; exit 1; }
cd "$BASE_DIR"
BASE_DIR=$PWD
APP_DIR=$(realpath -m "$APP_DIR")
LOG_DIR="$BASE_DIR/archive-logs/$RUN_ID"
mkdir -p "$LOG_DIR"
exec 3>&1
exec > >(tee -a "$LOG_DIR/deploy.log") 2>&1
STAGE=检查环境
LAST_LOG=
REASON=
SUCCESS=0
SWITCHED=0
COMPOSE=()
PREVIOUS=
STATE="$BASE_DIR/.archive-deploy"

finish() {
  local code=$?
  trap - EXIT INT TERM
  set +e
  (( SUCCESS == 0 )) || return
  (( code != 0 )) || code=1
  if (( ${#COMPOSE[@]} )); then
    timeout 20 "${COMPOSE[@]}" ps --all >"$LOG_DIR/containers.log" 2>&1
    timeout 20 "${COMPOSE[@]}" logs --no-color --tail 300 app >"$LOG_DIR/container.log" 2>&1
    if [[ $STAGE == 等待容器健康 && -s $LOG_DIR/container.log ]]; then LAST_LOG="$LOG_DIR/container.log"; fi
  fi
  if (( SWITCHED == 1 )) && [[ -n $PREVIOUS ]]; then
    timeout 120 docker compose -p "$PROJECT" --env-file "$PREVIOUS/runtime.env" \
      -f "$PREVIOUS/compose.yaml" up -d --no-build --pull never app >"$LOG_DIR/rollback.log" 2>&1
    echo "上一版本启动命令退出码：$?，详见rollback.log（数据库不自动回滚）。"
  fi
  {
    echo "失败阶段：$STAGE"
    echo "失败原因：${REASON:-命令执行失败，退出码$code}"
    if [[ -n $LAST_LOG && -s $LAST_LOG ]]; then cat "$LAST_LOG"; fi
  } >"$LOG_DIR/failure.log"
  { echo "部署失败；失败日志目录：$LOG_DIR"; echo '前30行日志：'; head -n 30 "$LOG_DIR/failure.log"; } >&3
  exit "$code"
}
trap finish EXIT
trap 'REASON=操作被中断; exit 130' INT
trap 'REASON=操作被终止; exit 143' TERM
die() { REASON=$1; echo "$REASON" >&2; exit 1; }
run() { local name=$1; shift; LAST_LOG="$LOG_DIR/$name.log"; "$@" 2>&1 | tee "$LAST_LOG"; }
git_app() { git -c "safe.directory=$APP_DIR" -c http.version=HTTP/1.1 -C "$APP_DIR" "$@"; }

for tool in git docker curl python3 timeout flock; do command -v "$tool" >/dev/null || die "缺少命令：$tool"; done
python3 - "$HTTP_PORT" "$RETRIES" "$HEALTH_TIMEOUT" "$APP_DIR" "$BASE_DIR" <<'PY'
import sys
port,retries,health,app,base=sys.argv[1:]
assert port.isdigit() and 1<=int(port)<=65535,'端口必须是1—65535'
assert retries.isdigit() and int(retries)>0 and health.isdigit() and int(health)>0,'重试次数和超时必须为正整数'
assert app.startswith(base+'/') and app!=base,'项目目录必须是启动目录的子目录'
PY
git check-ref-format --branch "$BRANCH" >/dev/null
exec 9>"$BASE_DIR/.archive-update.lock"
flock -n 9 || die '另一个档案项目部署任务正在运行。'
run docker-info timeout 20 docker info >/dev/null
run compose-version docker compose version
mkdir -p "$STATE/$RUN_ID"
RUN="$STATE/$RUN_ID"
if [[ -L $STATE/current ]]; then PREVIOUS=$(readlink -f "$STATE/current"); fi

echo '========== 开始部署档案台账系统 =========='
echo "启动目录：$BASE_DIR"
echo "代码目录：$APP_DIR"
STAGE=拉取代码
if [[ -d $APP_DIR/.git ]]; then
  [[ -z $(git_app status --porcelain) ]] || die '项目有未提交修改，停止更新，请先保留并处理这些修改。'
  [[ $(git_app branch --show-current) == "$BRANCH" ]] || die "当前分支不是$BRANCH，请先核对项目。"
  UPDATED=0
  for url in "$MIRROR_URL" "$GITHUB_URL"; do
    for ((n=1;n<=RETRIES;n++)); do
      echo "更新代码，第$n次：$url"
      if run "pull-$(basename "$url")-$n-${url//\//_}" timeout 120 git \
        -c "safe.directory=$APP_DIR" -c http.version=HTTP/1.1 -C "$APP_DIR" pull --ff-only "$url" "$BRANCH"; then UPDATED=1; break 2; fi
    done
  done
  (( UPDATED == 1 )) || die '所有代码源更新失败，现有容器保持运行。'
else
  [[ ! -e $APP_DIR ]] || die "目录已存在但不是Git仓库：$APP_DIR。请先核对，脚本不覆盖该目录。"
  UPDATED=0; attempt=0
  for url in "$MIRROR_URL" "$GITHUB_URL"; do
    for ((n=1;n<=RETRIES;n++)); do
      attempt=$((attempt+1))
      echo "首次克隆，第$n次：$url"
      if run "clone-$attempt" timeout 120 git -c http.version=HTTP/1.1 clone --branch "$BRANCH" --single-branch -- "$url" "$RUN/clone-$attempt"; then
        mv "$RUN/clone-$attempt" "$APP_DIR"; UPDATED=1; break 2
      fi
    done
  done
  (( UPDATED == 1 )) || die '所有代码源克隆失败，现有容器保持运行。'
fi
for file in Dockerfile deploy/docker/compose.yaml vendor/xlsx-0.20.3.tgz; do [[ -f $APP_DIR/$file ]] || die "项目缺少$file"; done
COMMIT=$(git_app rev-parse HEAD)
echo "代码更新成功，提交：$COMMIT"

STAGE=拉取基础镜像
read -r -a images <<<"${NODE_IMAGES:-docker.io/library/node:24.15.0-bookworm-slim public.ecr.aws/docker/library/node:24.15.0-bookworm-slim mirror.gcr.io/library/node:24.15.0-bookworm-slim}"
NODE_IMAGE=; attempt=0
for image in "${images[@]}"; do
  for ((n=1;n<=RETRIES;n++)); do
    attempt=$((attempt+1))
    if run "image-$attempt" timeout 180 docker pull "$image"; then NODE_IMAGE=$image; break 2; fi
  done
done
[[ -n $NODE_IMAGE ]] || die '全部基础镜像源均不可用，现有容器保持运行。'
STAGE=构建镜像
IMAGE="archive-ledger-local:$RUN_ID"
read -r -a registries <<<"${NPM_REGISTRIES:-https://registry.npmjs.org https://registry.npmmirror.com}"
BUILT=0; attempt=0
for registry in "${registries[@]}"; do
  attempt=$((attempt+1))
  if run "build-$attempt" timeout 1800 docker build --progress=plain \
    --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NPM_REGISTRY=$registry" --build-arg "SOURCE_COMMIT=$COMMIT" \
    -t "$IMAGE" -f "$APP_DIR/Dockerfile" "$APP_DIR"; then BUILT=1; break; fi
done
(( BUILT == 1 )) || die '全部npm源构建失败，现有容器保持运行。'

if [[ -z $PUBLIC_URL ]]; then
  address=
  if command -v ip >/dev/null; then address=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}') || true; fi
  if [[ -z $address ]]; then address=$(hostname -I | awk '{print $1}'); fi
  PUBLIC_URL="http://${address:-127.0.0.1}:$HTTP_PORT"
fi
PUBLIC_URL=${PUBLIC_URL%/}
python3 - "$PUBLIC_URL" <<'PY'
import sys
from urllib.parse import urlsplit
u=urlsplit(sys.argv[1])
assert u.scheme in ['http','https'] and u.hostname and not u.username and not u.password and not u.path and not u.query and not u.fragment and not any(c.isspace() for c in sys.argv[1]),'PUBLIC_URL须为实际访问源，不含路径或凭据'
PY
secure=0; [[ $PUBLIC_URL != https://* ]] || secure=1
printf 'ARCHIVE_IMAGE=%s\nARCHIVE_BIND_IP=0.0.0.0\nARCHIVE_HTTP_PORT=%s\nARCHIVE_ALLOWED_ORIGINS=%s\nARCHIVE_COOKIE_SECURE=%s\n' "$IMAGE" "$HTTP_PORT" "$PUBLIC_URL" "$secure" >"$RUN/runtime.env"
cp "$APP_DIR/deploy/docker/compose.yaml" "$RUN/compose.yaml"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$RUN/runtime.env" -f "$RUN/compose.yaml")
run compose-config "${COMPOSE[@]}" config --quiet
STAGE=升级前备份
old=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=app' --format '{{.ID}}')
if [[ -n $old ]]; then
  [[ $old != *$'\n'* ]] || die '发现多个档案应用容器，请先核对副本数量。'
  run backup timeout 300 docker exec "$old" node scripts/maintenance.mjs backup
fi
STAGE=启动容器
SWITCHED=1
run start timeout 180 "${COMPOSE[@]}" up -d --no-build --pull never app
STAGE=等待容器健康
deadline=$((SECONDS+HEALTH_TIMEOUT)); healthy=0
while ((SECONDS<deadline)); do
  cid=$("${COMPOSE[@]}" ps --all --quiet app)
  if [[ -n $cid ]]; then
    status=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid")
    echo "$status"
    if [[ $status == 'running healthy' ]]; then healthy=1; break; fi
    [[ $status != exited* && $status != dead* ]] || die "容器已退出：$status"
  fi
  sleep 2
done
((healthy==1)) || die '容器健康检查超时。'
STAGE=验证网站
run website curl -fsS --connect-timeout 5 --max-time 15 "$PUBLIC_URL/api/health"
run page curl -fsS --connect-timeout 5 --max-time 15 --output "$LOG_DIR/page.html" "$PUBLIC_URL/"
run validate python3 - "$LOG_DIR/website.log" "$LOG_DIR/page.html" <<'PY'
import json,sys
from pathlib import Path
data=json.loads(Path(sys.argv[1]).read_text())['data']
assert data.get('ok') is True and data.get('schemaVersion')==3,'API检查失败'
html=Path(sys.argv[2]).read_text()
assert '<div id="root">' in html and '/assets/' in html,'生产页面检查失败'
PY
ln -s "$RUN" "$STATE/current-$RUN_ID"
mv -Tf "$STATE/current-$RUN_ID" "$STATE/current"
SUCCESS=1
echo '========== 部署完成 =========='
echo "网站链接：$PUBLIC_URL"
echo "代码目录：$APP_DIR"
echo "日志目录：$LOG_DIR"
"${COMPOSE[@]}" ps
