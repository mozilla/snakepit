#!/usr/bin/env bash
worker_index=`hostname | sed -E 's/sp-([a-z][a-z0-9]*)-([0-9]+)-(d|0|[1-9][0-9]*)/\3/'`
head_node=`hostname | sed -E 's/sp-([a-z][a-z0-9]*)-([0-9]+)-(d|0|[1-9][0-9]*)/sp-head-\2-d.lxd/'`

mkdir /data
worker_dir="/data/pit/workers/${worker_index}"
while ! sshfs worker@${head_node}: /data -o cache=yes,kernel_cache,big_writes,sshfs_sync,Ciphers=aes128-ctr,reconnect,ServerAliveInterval=15,ServerAliveCountMax=100,StrictHostKeyChecking=no ; do
    sleep 2
done
while [ ! -d "${worker_dir}" ]; do
    sleep 1
done

log_file="${worker_dir}/worker.log"
print_log () {
    echo "[worker ${worker_index}] $1" >>"${log_file}"
}

print_log "Worker ${worker_index} started"
RESULT_FILE="${worker_dir}/result" bash "${worker_dir}/script.sh" 2>&1 | awk '{print "[worker '${worker_index}'] " $0}' >>"${log_file}"
exit_code=${PIPESTATUS[0]}
echo "$exit_code" >"${worker_dir}/status"
print_log "Worker ${worker_index} ended with exit code ${exit_code}"
touch "${worker_dir}/stop"
