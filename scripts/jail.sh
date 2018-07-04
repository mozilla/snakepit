interface=$(awk '$2 == 00000000 { print $1 }' /proc/net/route)
pid="${JOB_NUMBER}_${GROUP_INDEX}_${PROCESS_INDEX}"
process_dir="/dev/shm/snakepit_process_home_${pid}"
cuda=()

if [ ! -z $ALLOWED_CUDA_DEVICES ]; then
    for i in $(echo $ALLOWED_CUDA_DEVICES | sed "s/,/ /g"); do
        cuda+=(--noblacklist=/dev/nvidia$i)
    done
    cuda+=(--noblacklist=/dev/nvidiactl)
    cuda+=(--noblacklist=/dev/nvidia-uvm)
fi

mkdir -p "${process_dir}/resources/shared"
bindfs --no-allow-other -r "${DATA_ROOT}/shared" "${process_dir}/resources/shared"
mkdir -p "${process_dir}/resources/groups"
for group in $USER_GROUPS; do
    group_dir_src="${DATA_ROOT}/groups/$group"
    if [ -d "${group_dir_src}" ]; then
        group_dir_dst="${process_dir}/resources/groups/$group"
        mkdir -p "${group_dir_dst}"
        bindfs --no-allow-other -r "${group_dir_src}" "${group_dir_dst}"
    fi
done
mkdir -p "${process_dir}/job"
unionfs "${JOB_DIR}"=RW:"${process_dir}/resources"=RO "${process_dir}/job"

rmmount () {
    fusermount -u "$1"
    if [ -z "$(ls -A $1)" ]; then
        rm -rf "$1"
    fi
}

cleanup () {
    fusermount -u "${process_dir}/job"
    rmmount "${process_dir}/resources/shared"
    for group in $USER_GROUPS; do
        rmmount "${process_dir}/resources/groups/$group"
    done
    if [ -z "$(ls -A ${process_dir}/resources/groups)" ] && [ ! -d "${process_dir}/resources/shared" ] && [ ! -d "${process_dir}/job" ]; then
        rm -rf "${process_dir}"
    fi
}

#trap cleanup EXIT ERR INT TERM

jail () {
    firejail \
    --quiet \
    --profile=/etc/firejail/disable-common.inc \
    --private="${process_dir}/job" \
    --env=JOB_NUMBER=${JOB_NUMBER:=0} \
    --env=GROUP_INDEX=${GROUP_INDEX:=0} \
    --env=PROCESS_INDEX=${PROCESS_INDEX:=0} \
    --net="$interface" \
    --netfilter=/etc/firejail/nolocal.net \
    --blacklist="$DATA_ROOT" \
    "${cuda[@]}" \
    --blacklist="/dev/nvidia*" \
    --blacklist="$DATA_DIR" \
    "$@"
}
