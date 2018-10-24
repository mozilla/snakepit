start_jail () {
    if [ "$DECOUPLED" = true ]; then
        nohup firejail "${@}" 2>&1 >>/dev/null &
    else
        firejail "${@}" 2>&1 >/dev/null
    fi
}

jail () {
    cuda=()
    if [ ! -z $ALLOWED_CUDA_DEVICES ]; then
        for i in $(echo $ALLOWED_CUDA_DEVICES | sed "s/,/ /g"); do
            cuda+=(--noblacklist=/dev/nvidia$i)
        done
        cuda+=(--noblacklist=/dev/nvidiactl)
        cuda+=(--noblacklist=/dev/nvidia-uvm)
    fi

    exit_status=$1
    prefix=$2
    log_file=$3
    script=$4

    start_jail \
    --private \
    --noprofile \
    --env=NODE=${NODE} \
    --env=JOB_NUMBER=${JOB_NUMBER:=0} \
    --env=GROUP_INDEX=${GROUP_INDEX:=0} \
    --env=PROCESS_INDEX=${PROCESS_INDEX:=0} \
    --env=EXTRA_WAIT_TIME=${EXTRA_WAIT_TIME:=0} \
    "${cuda[@]}" \
    --blacklist="/dev/nvidia*" \
    --blacklist="${DATA_ROOT}" \
    bash -c \
      $'set -e -o pipefail;\
        cd ~;\
        mkdir jobfs;\
        httpfs \
            --cache \
            --blocksize 10M \
            --nocache "*.log,*.hdf5" \
            --certraw \''"${JOB_FS_CERT}"$'\' \
            \''"${JOB_FS_URL}"$'\' \
            jobfs &\
        while [ ! -d jobfs/job ]; do sleep 0.1; done;\
        export DATA_ROOT=~/jobfs ;\
        export JOB_DIR=~/jobfs/job ;\
        cd ~/jobfs/job/src;\
        {\n echo "Running '${script}$' script...";\
            bash "../'${script}$'.sh";\
            echo "$?" >../'${exit_status}$';\
            echo "Finished '${script}$' script.";\
            sleep '${EXTRA_WAIT_TIME}$';\n\
        } 2>&1 | \
            while IFS= read -r line; do \
                printf "[%s][%s] %s\\n" "$(date -u "+%Y-%m-%d %H:%M:%S")" "'${prefix}$'" "$line";\
            done >>"../'${log_file}$'";\
        status_code=`cat ../'${exit_status}$'`;\
        kill $(jobs -p);\
        exit $status_code' \
    2>&1 >/dev/null
}
