#!/usr/bin/env bash

touch /data/pit/daemon.log
print_log () {
    echo "[daemon] $1" >>/data/pit/daemon.log
}

if [ -f "/data/pit/run" ]; then
    print_log "This pit already ran. Requesting stop..."
    touch "/data/pit/stop"
fi
touch "/data/pit/run"

for worker_dir in /data/pit/workers/*/ ; do
    worker_dir=${worker_dir%*/}
    touch "${worker_dir}/worker.log"
    chown -R worker:worker "$worker_dir"
done

tail -F -q /data/pit/daemon.log /data/pit/workers/**/worker.log | ts '[%Y-%m-%d %H:%M:%S]' >/data/pit/pit.log &

print_log "Pit daemon started"
while true; do
    for worker_dir in /data/pit/workers/*/ ; do
        worker_dir=${worker_dir%*/}
        worker_index=${worker_dir##*/}
        if [ -f "${worker_dir}/stop" ]; then
            print_log "Worker ${worker_index} requested stop. Stopping pit..."
            touch "/data/pit/stop"
        fi
    done
	sleep 1
done
