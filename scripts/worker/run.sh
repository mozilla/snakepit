#!/usr/bin/env bash
eval $(cat /data/pit/pit_info | sed -E 's/([^=]+)=(.*)$/\1="\2"/')
worker_index=`hostname | sed -E 's/sp-([a-z][a-z0-9]*)-([0-9]+)-(d|0|[1-9][0-9]*)/\3/'`

worker_dir="/data/pit/workers/${worker_index}"
while [ ! -d "${worker_dir}" ]; do
    sleep 1
done

log_file="${worker_dir}/worker.log"
print_log () {
    echo "[worker ${worker_index}] $1" >>"${log_file}"
}

print_log "Worker ${worker_index} started"
RESULT_FILE="${worker_dir}/result" bash "/usr/bin/script.sh" | awk '{print [worker '${worker_index}'] $0}' 2>&1 >>"${log_file}"
echo "$?" >"${worker_dir}/status"
print_log "Worker ${worker_index} finished"
touch "${worker_dir}/stop"
