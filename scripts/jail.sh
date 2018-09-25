
jail () {
    cuda=()
    if [ ! -z $ALLOWED_CUDA_DEVICES ]; then
        for i in $(echo $ALLOWED_CUDA_DEVICES | sed "s/,/ /g"); do
            cuda+=(--noblacklist=/dev/nvidia$i)
        done
        cuda+=(--noblacklist=/dev/nvidiactl)
        cuda+=(--noblacklist=/dev/nvidia-uvm)
    fi
    
    firejail \
    --quiet \
    --private \
    --noprofile \
    --env=NODE=${NODE} \
    --env=JOB_NUMBER=${JOB_NUMBER:=0} \
    --env=GROUP_INDEX=${GROUP_INDEX:=0} \
    --env=PROCESS_INDEX=${PROCESS_INDEX:=0} \
    "${cuda[@]}" \
    --blacklist="/dev/nvidia*" \
    --blacklist="${DATA_ROOT}" \
    bash -c \
       "cd ~;\
        mkdir jobfs;\
        httpfs --quiet --cache --certraw '${JOB_FS_CERT}' '${JOB_FS_URL}' jobfs &\
        while [ ! -d jobfs/job ]; do sleep 0.1; done;\
        export DATA_ROOT=~/jobfs ;\
        export JOB_DIR=~/jobfs/job ;\
        cd ~/jobfs/job/src;\
        $@;\
        kill \$(jobs -p);"
}
