#!/usr/bin/env bash

if [ "$HOSTNAME" = snakepit-worker ]; then
    exit 0
fi

while [[ ! -f "/env.sh" ]]; do
    sleep 0.1
done

export DEBIAN_FRONTEND=noninteractive
source "/etc/profile"
source "/env.sh"

mkdir /data
worker_dir="/data/rw/pit/workers/${WORKER_INDEX}"

i=0
while ! sshfs worker@${DAEMON}: /data -o IdentityFile=/root/.ssh/id_rsa,cache=yes,kernel_cache,big_writes,sshfs_sync,Ciphers=aes128-ctr,reconnect,ServerAliveInterval=15,ServerAliveCountMax=100,StrictHostKeyChecking=no ; do
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
pipe_log () {
    stdbuf -oL awk '{print "[worker '${WORKER_INDEX}'] " $0}' >>"${log_file}"
}
print_log () {
    echo "$1" | pipe_log
}

print_log "Worker ${WORKER_INDEX} started"
print_log "Preparing script execution..."
apt-get update 2>&1 | pipe_log
systemctl stop apt-daily.service
systemctl kill --kill-who=all apt-daily.service
while ! (systemctl list-units --all apt-daily.service | fgrep -q dead) ; do sleep 1; done
print_log "Starting script..."
stdbuf -oL bash "/data/rw/pit/script.sh" 2>&1 | pipe_log
exit_code=${PIPESTATUS[0]}
echo "$exit_code" >"${worker_dir}/status"
print_log "Worker ${WORKER_INDEX} ended with exit code ${exit_code}"
touch "${worker_dir}/stop"
poweroff
