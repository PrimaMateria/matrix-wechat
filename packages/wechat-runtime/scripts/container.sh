#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
package_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
data_dir="$repo_dir/data/wechat"
engine="${WECHATLINUX_ENGINE:-podman}"
container_name=wechatlinux-demo
image_name=localhost/wechatlinux-demo:dev

usage() {
    cat <<'EOF'
Usage: container.sh [--engine podman|docker] COMMAND [args]

  build        Build the web/helper runtime image (never starts WeChat)
  start        Start the isolated container with its bundled WeChat client
  stop         Stop the container; preserve all data/wechat files
  status       Show container state
  logs         Show container logs; extra engine log flags are accepted

Defaults: rootless Podman, localhost/wechatlinux-demo:dev, wechatlinux-demo.
Persistent state: repository-root/data/wechat mounted at /home/wechat.
QR login page: http://127.0.0.1:18742/
EOF
}

while (($#)); do
    case "$1" in
        --engine)
            option="$1"
            if (($# < 2)); then printf '%s needs a value\n' "$option" >&2; exit 2; fi
            engine="$2"
            shift 2
            ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        -*) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
        *) break ;;
    esac
done
if (($# == 0)); then usage >&2; exit 2; fi
command="$1"
shift
case "$engine" in podman|docker) ;; *) printf 'Engine must be podman or docker\n' >&2; exit 2 ;; esac
if ! command -v "$engine" >/dev/null; then printf '%s is not installed\n' "$engine" >&2; exit 1; fi

exists() { "$engine" container inspect "$container_name" >/dev/null 2>&1; }
running() { [[ $("$engine" container inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null) == true ]]; }

case "$command" in
    build)
        if (($#)); then printf 'build takes no arguments\n' >&2; exit 2; fi
        "$engine" build --tag "$image_name" --file "$package_dir/Dockerfile" "$repo_dir"
        ;;
    start)
        if (($#)); then printf 'start takes no arguments\n' >&2; exit 2; fi
        if running; then
            printf '%s is already running. QR: http://127.0.0.1:18742/\n' "$container_name"
            exit 0
        fi
        umask 077
        mkdir -p "$data_dir"
        chmod 0700 "$data_dir"
        if exists; then "$engine" rm "$container_name" >/dev/null; fi
        run_options=(--detach --name "$container_name" --cap-drop ALL --cap-add SYS_PTRACE --cap-add SYS_CHROOT
            --security-opt no-new-privileges --publish 127.0.0.1:18742:18742
            --volume "$data_dir:/home/wechat:Z" --shm-size 256m)
        if [[ -f "$repo_dir/.env" ]]; then
            runtime_env_file=$(mktemp)
            trap 'rm -f "$runtime_env_file"' EXIT
            sed -n -E '/^[[:space:]]*(WECHAT_[A-Z0-9_]+|TZ)=/p' "$repo_dir/.env" > "$runtime_env_file"
            run_options+=(--env-file "$runtime_env_file")
        fi
        if [[ -n "${WECHAT_API_TOKEN:-}" ]]; then run_options+=(--env WECHAT_API_TOKEN); fi
        if [[ -n "${WECHAT_WEB_UI:-}" ]]; then run_options+=(--env WECHAT_WEB_UI); fi
        if [[ "$engine" == podman ]]; then
            if [[ $("$engine" info --format '{{.Host.Security.Rootless}}') != true ]]; then
                printf 'Run Podman as an ordinary user; this launcher requires rootless Podman\n' >&2
                exit 1
            fi
            run_options+=(--userns keep-id:uid=1000,gid=1000)
        fi
        "$engine" run "${run_options[@]}" "$image_name"
        printf 'QR login page: http://127.0.0.1:18742/\n'
        ;;
    stop)
        if (($#)); then printf 'stop takes no arguments\n' >&2; exit 2; fi
        if exists; then "$engine" stop --time 20 "$container_name"; else printf '%s is not created\n' "$container_name"; fi
        ;;
    status)
        if (($#)); then printf 'status takes no arguments\n' >&2; exit 2; fi
        if exists; then "$engine" container inspect --format '{{.Name}}: {{.State.Status}} ({{.State.Running}})' "$container_name"; else printf '%s is not created\n' "$container_name"; fi
        ;;
    logs) "$engine" logs "$@" "$container_name" ;;
    *) printf 'Unknown command: %s\n' "$command" >&2; usage >&2; exit 2 ;;
esac
