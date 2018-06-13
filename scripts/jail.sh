interface=$(awk '$2 == 00000000 { print $1 }' /proc/net/route)

jail () {
    args=()
    cuda=()
    for group in $USER_GROUPS; do
        data_group_dir="$DATA_ROOT/groups/$group"
        args+=(--read-only="$data_group_dir")
        args+=(--noblacklist="$data_group_dir")
    done
    if [ ! -z $CUDA_VISIBLE_DEVICES ]; then
        for i in $(echo $CUDA_VISIBLE_DEVICES | sed "s/,/ /g"); do
            cuda+=(--noblacklist=/dev/nvidia$i)
        done
        cuda+=(--noblacklist=/dev/nvidiactl)
        cuda+=(--noblacklist=/dev/nvidia-uvm)
    fi
    
    firejail \
    --quiet \
    --env=JOB_NUMBER=${JOB_NUMBER:=0} \
    --env=GROUP_INDEX=${GROUP_INDEX:=0} \
    --env=PROCESS_INDEX=${PROCESS_INDEX:=0} \
    --net="$interface" \
    --netfilter=/etc/firejail/nolocal.net \
    --read-write="${JOB_DIR}" \
    --noblacklist="${JOB_DIR}" \
    --blacklist="${DATA_ROOT}/jobs/*" \
    "${args[@]}" \
    --blacklist="$DATA_ROOT/groups/*" \
    --blacklist="$DATA_ROOT/uploads" \
    --blacklist="$DATA_ROOT/cache" \
    --blacklist="$DATA_ROOT/db.json" \
    "${cuda[@]}" \
    --blacklist="/dev/nvidia*" \
    --blacklist="$HOME/.snakepit" \
    "$@"
}
