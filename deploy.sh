#!/usr/bin/env bash
# Linux: fetch source, try alternate registries, build and health-check Compose.
set -Eeuo pipefail
umask 077

if [[ ${1:-} == --help ]]; then
  printf '%s\n' '用法：bash deploy.sh' \
    '可配置：DEPLOY_DIR BRANCH REPO_URL EXPECTED_COMMIT PUBLIC_URL HTTP_PORT BIND_IP' \
    '多源配置（空格分隔）：GIT_URLS NODE_IMAGES NPM_REGISTRIES' \
    '详情见 deploy/docker/README.md。需要Linux、Docker Compose、Git、curl、Python3、flock、timeout。'
  exit 0
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
DEPLOY_DIR=${DEPLOY_DIR:-/opt/archive-ledger}
LOG_BASE=${LOG_BASE:-$DEPLOY_DIR/logs}
LOG_DIR="$LOG_BASE/$RUN_ID"
if ! mkdir -p "$LOG_DIR"; then
  LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/archive-deploy-$RUN_ID-XXXXXX")
  printf '无法使用配置的日志目录，改用：%s\n' "$LOG_DIR" >&2
fi
exec 3>&1 4>&2
exec > >(tee -a "$LOG_DIR/deploy.log") 2>&1

STAGE=初始化
FAILED_LOG=
SUCCESS=0
SWITCHED=0
REASON=
PREVIOUS_RUN=
COMPOSE=()
PROJECT=${PROJECT:-archive-ledger}
SOURCE_COMMIT=
PUBLIC_URL=${PUBLIC_URL:-}

finish() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if (( SUCCESS == 1 && rc == 0 )); then return; fi
  (( rc != 0 )) || rc=1
  REASON=${REASON:-"命令执行失败（退出码 $rc）"}
  if command -v docker >/dev/null && command -v timeout >/dev/null; then
    if (( ${#COMPOSE[@]} > 0 )); then
      timeout 20 "${COMPOSE[@]}" ps --all >"$LOG_DIR/compose-ps.log" 2>&1
      timeout 20 "${COMPOSE[@]}" logs --no-color --tail 300 app >"$LOG_DIR/container.log" 2>&1
      if [[ $STAGE == 健康检查 && $FAILED_LOG == "$LOG_DIR/health.log" && -s $LOG_DIR/container.log ]]; then FAILED_LOG="$LOG_DIR/container.log"; fi
    fi
    timeout 15 docker version >"$LOG_DIR/docker-version.log" 2>&1
  fi
  if (( SWITCHED == 1 )) && [[ -n $PREVIOUS_RUN && -f $PREVIOUS_RUN/runtime.env ]]; then
    printf '尝试重新启动上一版本，保留当前数据卷。\n'
    timeout 120 docker compose --project-name "$PROJECT" --env-file "$PREVIOUS_RUN/runtime.env" \
      -f "$PREVIOUS_RUN/source/deploy/docker/compose.yaml" up -d --no-build --pull never app >"$LOG_DIR/rollback.log" 2>&1
    printf '上一版本启动命令退出码：%s（详见rollback.log，数据不自动回滚）\n' "$?"
  fi
  {
    printf '失败阶段：%s\n失败原因：%s\n' "$STAGE" "$REASON"
    if [[ -n $FAILED_LOG && -s $FAILED_LOG ]]; then cat "$FAILED_LOG"; fi
  } >"$LOG_DIR/failure.log"
  if command -v python3 >/dev/null; then
    python3 - "$LOG_DIR" "$STAGE" "$REASON" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1],'result.json').write_text(json.dumps({'success':False,'stage':sys.argv[2],'reason':sys.argv[3],'logDirectory':sys.argv[1]},ensure_ascii=False,indent=2)+'\n')
PY
  fi
  {
    printf '\n部署失败（退出码 %s）\n失败日志目录：%s\n前30行日志（failure.log）：\n' "$rc" "$LOG_DIR"
    head -n 30 "$LOG_DIR/failure.log"
  } | tee "$LOG_DIR/result.txt" >&3
  exit "$rc"
}
trap finish EXIT
trap 'REASON="部署被中断"; exit 130' INT
trap 'REASON="部署被终止"; exit 143' TERM

die() { REASON=$1; printf '%s\n' "$REASON" >&2; exit 1; }
step() {
  local name=$1
  shift
  FAILED_LOG="$LOG_DIR/$name.log"
  printf '\n[%s] %s\n' "$STAGE" "$name"
  "$@" 2>&1 | tee "$FAILED_LOG"
}

[[ $(uname -s) == Linux ]] || die '此脚本用于Linux服务器。'
for tool in git docker curl python3 flock timeout tee head; do
  command -v "$tool" >/dev/null || die "缺少依赖：$tool。请先安装后重试。"
done

HTTP_PORT=${HTTP_PORT:-8080}
BIND_IP=${BIND_IP:-0.0.0.0}
BRANCH=${BRANCH:-main}
REPO_URL=${REPO_URL:-https://github.com/haonanhu02-jpg/f.git}
EXPECTED_COMMIT=${EXPECTED_COMMIT:-}
RETRIES=${RETRIES:-2}
GIT_TIMEOUT=${GIT_TIMEOUT:-120}
PULL_TIMEOUT=${PULL_TIMEOUT:-180}
BUILD_TIMEOUT=${BUILD_TIMEOUT:-1800}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-120}

python3 - "$HTTP_PORT" "$BIND_IP" "$PROJECT" "$BRANCH" "$EXPECTED_COMMIT" "$RETRIES" "$GIT_TIMEOUT" "$PULL_TIMEOUT" "$BUILD_TIMEOUT" "$HEALTH_TIMEOUT" <<'PY'
import ipaddress,re,sys
port,bind,project,branch,commit,*numbers=sys.argv[1:]
assert port.isdigit() and 1<=int(port)<=65535,'HTTP_PORT必须是1—65535'
assert ipaddress.ip_address(bind).version==4,'BIND_IP目前支持IPv4'
assert re.fullmatch(r'[a-z0-9][a-z0-9_-]*',project),'PROJECT格式无效'
assert not branch.startswith('-') and not any(c.isspace() for c in branch),'BRANCH格式无效'
assert not commit or re.fullmatch('[a-fA-F0-9]{40}',commit),'EXPECTED_COMMIT须为完整40位SHA'
assert all(n.isdigit() and int(n)>0 for n in numbers),'重试次数和超时必须为正整数'
PY
git check-ref-format --branch "$BRANCH" >/dev/null
DEPLOY_DIR=$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$DEPLOY_DIR")
[[ $DEPLOY_DIR != / ]] || die 'DEPLOY_DIR不能为根目录。'
mkdir -p "$DEPLOY_DIR/releases"
exec 9>"$DEPLOY_DIR/.deploy.lock"
flock -n 9 || die '已有部署任务正在运行，请等待该任务结束。'
[[ ! -e $DEPLOY_DIR/current || -L $DEPLOY_DIR/current ]] || die 'current已存在且不是符号链接，请先核对安装目录。'
if [[ -L $DEPLOY_DIR/current ]]; then PREVIOUS_RUN=$(readlink -f "$DEPLOY_DIR/current"); fi
RUN_DIR="$DEPLOY_DIR/releases/$RUN_ID"
mkdir "$RUN_DIR"

STAGE=环境检查
step docker-info timeout 20 docker info >/dev/null
step compose-version docker compose version

if [[ -z $PUBLIC_URL ]]; then
  if [[ $BIND_IP != 0.0.0.0 ]]; then
    address=$BIND_IP
  else
    address=
    if command -v ip >/dev/null; then
      address=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}') || true
    fi
    if [[ -z $address ]]; then address=$(hostname -I 2>/dev/null | awk '{print $1}'); fi
    address=${address:-127.0.0.1}
  fi
  PUBLIC_URL="http://$address:$HTTP_PORT"
fi
PUBLIC_URL=${PUBLIC_URL%/}
python3 - "$PUBLIC_URL" <<'PY'
import sys
from urllib.parse import urlsplit
u=urlsplit(sys.argv[1])
assert u.scheme in ['http','https'] and u.hostname and not u.username and not u.password,'PUBLIC_URL必须为无账号密码的HTTP(S)地址'
assert not u.path and not u.query and not u.fragment and not any(c.isspace() for c in sys.argv[1]),'PUBLIC_URL应仅含协议、主机及端口'
PY

if [[ -n ${GIT_URLS:-} ]]; then
  read -r -a git_urls <<<"$GIT_URLS"
else
  git_urls=("$REPO_URL")
  if [[ $REPO_URL == https://github.com/* ]]; then
    git_urls+=("https://gitclone.com/github.com/${REPO_URL#https://github.com/}")
  fi
fi
read -r -a node_images <<<"${NODE_IMAGES:-docker.io/library/node:24.15.0-bookworm-slim public.ecr.aws/docker/library/node:24.15.0-bookworm-slim mirror.gcr.io/library/node:24.15.0-bookworm-slim}"
read -r -a npm_registries <<<"${NPM_REGISTRIES:-https://registry.npmjs.org https://registry.npmmirror.com}"
for source in "$REPO_URL" "${git_urls[@]}"; do
  [[ $source != *'@'* ]] || die 'Git源URL中不能包含凭据，请使用Git凭据管理器；本脚本不将凭据写入URL。'
done

STAGE=拉取代码
# If upstream is reachable, pin its branch SHA and reject stale/mismatched mirrors.
if timeout "$GIT_TIMEOUT" git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 ls-remote "$REPO_URL" "refs/heads/$BRANCH" >"$LOG_DIR/upstream-ref.log" 2>&1; then
  upstream=$(awk -v ref="refs/heads/$BRANCH" '$2==ref {print $1;exit}' "$LOG_DIR/upstream-ref.log")
  [[ -n $upstream ]] || die "仓库为空或分支不存在：$REPO_URL（$BRANCH）。请先上传完整项目代码。"
  if [[ -z $EXPECTED_COMMIT ]]; then EXPECTED_COMMIT=$upstream; fi
elif [[ -z $EXPECTED_COMMIT ]]; then
  printf '上游暂不可达，将尝试配置的镜像分支；本次提交SHA会写入日志。可设置EXPECTED_COMMIT锁定版本。\n'
fi
selected=
attempt=0
for source in "${git_urls[@]}"; do
  for (( retry=1; retry<=RETRIES; retry++ )); do
    attempt=$((attempt+1))
    checkout="$RUN_DIR/clone-$attempt"
    printf '代码源 %s（第%s次）：%s\n' "$attempt" "$retry" "$source"
    if step "git-$attempt" timeout "$GIT_TIMEOUT" git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=30 \
      clone --depth 1 --single-branch --branch "$BRANCH" -- "$source" "$checkout"; then
      commit=$(git -C "$checkout" rev-parse HEAD)
      if [[ -n $EXPECTED_COMMIT && ${commit,,} != ${EXPECTED_COMMIT,,} ]]; then
        printf '提交不匹配：%s，预期：%s；继续下一个源。\n' "$commit" "$EXPECTED_COMMIT" | tee -a "$FAILED_LOG"
        continue
      fi
      selected=$checkout
      SOURCE_COMMIT=$commit
      break 2
    fi
  done
done
[[ -n $selected ]] || die '所有代码源拉取失败或提交SHA不匹配。'
mv "$selected" "$RUN_DIR/source"
SOURCE_DIR="$RUN_DIR/source"
for required in Dockerfile deploy/docker/compose.yaml deploy/docker/install-dependencies.mjs vendor/xlsx-0.20.3.tgz frontend/package-lock.json backend/package-lock.json; do
  [[ -f $SOURCE_DIR/$required ]] || die "仓库缺少必要文件：$required。请上传包含容器部署配置的完整项目。"
done
printf '本次提交：%s\n' "$SOURCE_COMMIT"

STAGE=拉取基础镜像
NODE_IMAGE=
attempt=0
for image in "${node_images[@]}"; do
  for (( retry=1; retry<=RETRIES; retry++ )); do
    attempt=$((attempt+1))
    if step "pull-$attempt" timeout "$PULL_TIMEOUT" docker pull "$image"; then NODE_IMAGE=$image; break 2; fi
  done
done
[[ -n $NODE_IMAGE ]] || die '所有容器基础镜像源均拉取失败。'

STAGE=构建镜像
ARCHIVE_IMAGE="archive-ledger-local:$RUN_ID"
built=0
attempt=0
for registry in "${npm_registries[@]}"; do
  attempt=$((attempt+1))
  if step "build-$attempt" timeout "$BUILD_TIMEOUT" docker build --progress=plain \
    --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NPM_REGISTRY=$registry" --build-arg "SOURCE_COMMIT=$SOURCE_COMMIT" \
    --tag "$ARCHIVE_IMAGE" --file "$SOURCE_DIR/Dockerfile" "$SOURCE_DIR"; then built=1; break; fi
done
(( built == 1 )) || die '使用全部npm镜像源构建后仍然失败。'

secure=0
[[ $PUBLIC_URL != https://* ]] || secure=1
cat >"$RUN_DIR/runtime.env" <<EOF
ARCHIVE_IMAGE=$ARCHIVE_IMAGE
ARCHIVE_BIND_IP=$BIND_IP
ARCHIVE_HTTP_PORT=$HTTP_PORT
ARCHIVE_ALLOWED_ORIGINS=$PUBLIC_URL
ARCHIVE_COOKIE_SECURE=$secure
ARCHIVE_TRUST_PROXY=${TRUST_PROXY:-0}
EOF
COMPOSE=(docker compose --project-name "$PROJECT" --env-file "$RUN_DIR/runtime.env" -f "$SOURCE_DIR/deploy/docker/compose.yaml")
step compose-config "${COMPOSE[@]}" config --quiet

STAGE=升级前备份
old_id=$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=app' --format '{{.ID}}')
if [[ -n $old_id ]]; then
  [[ $old_id != *$'\n'* ]] || die '发现多个应用容器，拒绝自动替换，请检查副本数量。'
  step pre-upgrade-backup timeout 300 docker exec "$old_id" node scripts/maintenance.mjs backup
fi

STAGE=启动容器
SWITCHED=1
step compose-up timeout 180 "${COMPOSE[@]}" up -d --no-build --pull never app

STAGE=健康检查
FAILED_LOG="$LOG_DIR/health.log"
deadline=$((SECONDS+HEALTH_TIMEOUT))
healthy=0
while (( SECONDS < deadline )); do
  cid=$("${COMPOSE[@]}" ps --all --quiet app)
  if [[ -n $cid ]]; then
    state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid")
    printf '%s\n' "$state" | tee -a "$LOG_DIR/health.log"
    if [[ $state == 'running healthy' ]]; then healthy=1; break; fi
    [[ $state != exited* && $state != dead* ]] || die "容器已退出：$state"
  fi
  sleep 2
done
(( healthy == 1 )) || die "容器未在${HEALTH_TIMEOUT}秒内通过健康检查。"
probe_ip=$BIND_IP
[[ $probe_ip != 0.0.0.0 ]] || probe_ip=127.0.0.1
probe="http://$probe_ip:$HTTP_PORT"
step host-health curl --fail --silent --show-error --connect-timeout 5 --max-time 15 "$probe/api/health"
step host-page curl --fail --silent --show-error --connect-timeout 5 --max-time 15 --output "$LOG_DIR/index.html" "$probe/"
# Validate the printed URL as well, including certificates for HTTPS endpoints.
step website-health curl --fail --silent --show-error --connect-timeout 5 --max-time 15 "$PUBLIC_URL/api/health"
step website-page curl --fail --silent --show-error --connect-timeout 5 --max-time 15 --output "$LOG_DIR/website.html" "$PUBLIC_URL/"
step validate-api python3 - "$LOG_DIR/host-health.log" "$LOG_DIR/website-health.log" <<'PY'
import json,sys
from pathlib import Path
for file in sys.argv[1:]:
    data=json.loads(Path(file).read_text())['data']
    assert data.get('ok') is True and data.get('schemaVersion')==3,'健康接口返回异常'
PY
step validate-page python3 - "$LOG_DIR/index.html" "$LOG_DIR/website.html" <<'PY'
import sys
from pathlib import Path
for file in sys.argv[1:]:
    page=Path(file).read_text()
    assert '<div id="root">' in page and '/assets/' in page,'返回的不是档案系统生产页面'
PY

STAGE=完成
ln -s "$RUN_DIR" "$DEPLOY_DIR/current-$RUN_ID"
mv -Tf "$DEPLOY_DIR/current-$RUN_ID" "$DEPLOY_DIR/current"
python3 - "$LOG_DIR" "$PUBLIC_URL" "$SOURCE_COMMIT" "$NODE_IMAGE" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1],'result.json').write_text(json.dumps({'success':True,'url':sys.argv[2],'commit':sys.argv[3],'baseImage':sys.argv[4],'logDirectory':sys.argv[1]},ensure_ascii=False,indent=2)+'\n')
PY
SUCCESS=1
printf '\n部署成功\n网站链接：%s\n提交：%s\n日志目录：%s\n' "$PUBLIC_URL" "$SOURCE_COMMIT" "$LOG_DIR" | tee "$LOG_DIR/result.txt"
