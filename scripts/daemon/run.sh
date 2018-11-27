#!/usr/bin/env bash
source /etc/pit_info

mkdir -p /data/pit
chown worker:worker /data/pit
touch /data/pit/daemon.log
print_log () {
    echo "[${PIT_ROLE}] $1" >>/data/pit/daemon.log
}

if [ -f /data/pit/run ]; then
    print_log "This pit already ran. Shutdown..."
    shutdown 0
fi
touch /data/pit/run

mkdir -p /data/pit/workers
worker_index=0
while [ ${worker_index} -lt ${PIT_WORKER_COUNT} ]; do
    worker_dir="/data/pit/workers/${worker_index}"
    mkdir -p "${worker_dir}"
    touch "${worker_dir}/worker.log"
    chown -R worker:worker "$worker_dir"
    ((worker_index++))
done

tail -F -q /data/pit/daemon.log /data/pit/workers/**/worker.log | ts '[%Y-%m-%d %H:%M:%S]' >/data/pit/pit.log &

print_log "Pit daemon started"
while true; do
    worker_index=0
    while [ ${worker_index} -lt ${PIT_WORKER_COUNT} ]; do
        if [ -f "/data/pit/workers/${worker_index}/stop" ]; then
            print_log "Worker ${worker_index} requested stop. Shutdown..."
            shutdown 0
        fi
        ((worker_index++))
    done
	sleep 1
done
