#!/usr/bin/env bash
source /etc/pit_info

mkdir -p /data/pit

print_log () {
    echo "[${PIT_ROLE}] $1" >>/data/pit/daemon.log
}

if [ -f /data/pit/run ]; then
    print_log "This pit already ran. Shutdown..."
    shutdown 0
fi
touch /data/pit/run

mkdir -p /data/workers
worker_index=0
while [ ${worker_index} -lt ${PIT_WORKER_COUNT} ]; do
    worker_dir="/data/workers/${worker_index}"
    mkdir -p "${worker_dir}"
    touch "${worker_dir}/worker.log"
    ((worker_index++))
done

tail -F -q /data/pit/daemon.log /data/workers/**/worker.log | ts '[%Y-%m-%d %H:%M:%S]' >/data/pit/pit.log &

print_log "Pit daemon started"
while true; do
    worker_index=0
    if [ -f /data/pit/stop ]; then
        typeset -i worker_index=$(cat /data/pit/stop)
        print_log "Worker ${worker_index} requested stop. Shutdown..."
        shutdown 0
    fi
    while [ ${worker_index} -lt ${PIT_WORKER_COUNT} ]; do
        if ! ping -c 30 "${PIT_WORKER_PREFIX}${worker_index}${PIT_WORKER_SUFFIX}" &>/dev/null; then
            print_log "Worker ${worker_index} seems down. Shutdown..."
            shutdown 0
        fi
        ((worker_index++))
    done
	sleep 1
done
