#!/usr/bin/env bash
source /etc/pit_info

worker_dir="/data/workers/${PIT_WORKER_INDEX}"
while [ ! -d "$worker_dir" ]; do
    sleep 1
done

log_file="${worker_dir}/worker.log"
print_log () {
    echo "[${PIT_ROLE}] $1" >>"${log_file}"
}

prepend () {
    while read -r line; do print_log $line; done
}

stopper () {
    while true; do
        sleep 10
        if [ -f "/data/pit/stop" ]; then
            shutdown 0
        fi
    done
}

print_log "Worker ${PIT_WORKER_INDEX} started"
stopper &
bash "/usr/bin/script.sh" | awk '{print ['${PIT_ROLE}'] $0}' >>"${log_file}"
echo "$?" >"${worker_dir}/status"
echo "${PIT_WORKER_INDEX}" >"/data/pit/stop"
print_log "Worker ${PIT_WORKER_INDEX} finished. Shutdown..."
shutdown 0
