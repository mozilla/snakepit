#!/usr/bin/env bash

if [ "$HOSTNAME" = snakepit-worker ]; then
    exit 0
fi

while [[ ! -f "/env.sh" ]]; do
    sleep 0.1
done
source "/env.sh"

mkdir /data
worker_dir="/data/rw/pit/workers/${WORKER_INDEX}"

i=0
while ! sshfs worker@${DAEMON}: /data -o cache=yes,kernel_cache,big_writes,sshfs_sync,Ciphers=aes128-ctr,reconnect,ServerAliveInterval=15,ServerAliveCountMax=100,StrictHostKeyChecking=no ; do
    if [[ ${i} -gt 5 ]]; then
        reboot
    fi
    let i=i+1
    sleep 1
done

i=0
while [[ ! -d "${worker_dir}" ]]; do
    if [[ ${i} -gt 5 ]]; then
        reboot
    fi
    let i=i+1
    sleep 1
done

cd "${WORK_DIR}"
export RESULT_FILE="${worker_dir}/result"

log_file="${worker_dir}/worker.log"
print_log () {
    echo "[worker ${WORKER_INDEX}] $1" >>"${log_file}"
}

print_log "Worker ${WORKER_INDEX} started"
stdbuf -oL bash "/data/rw/pit/script.sh" 2>&1 | stdbuf -oL awk '{print "[worker '${WORKER_INDEX}'] " $0}' >>"${log_file}"
exit_code=${PIPESTATUS[0]}
echo "$exit_code" >"${worker_dir}/status"
print_log "Worker ${WORKER_INDEX} ended with exit code ${exit_code}"
touch "${worker_dir}/stop"
