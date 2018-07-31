set -e

mkdir "$JOB_DIR/tmp"
if [ -n "$CONTINUE_JOB_NUMBER" ]; then
    cp -r "$DATA_ROOT/jobs/$CONTINUE_JOB_NUMBER/keep" "$JOB_DIR/keep"
else
    mkdir "$JOB_DIR/keep"
fi

job_src_dir="$JOB_DIR/src"

if [ -f "$JOB_DIR/public-origin.txt" ]; then
    origin=`cat $JOB_DIR/public-origin.txt`
    hash=`cat $JOB_DIR/hash.txt`
    mkdir -p "$DATA_ROOT/cache"
    cache_entry=`echo -n $origin | md5sum | cut -f1 -d" "`
    cache_repo="$DATA_ROOT/cache/$cache_entry"
    if [ -d "$cache_repo" ]; then
        git -C "$cache_repo" fetch --all >/dev/null
        touch "$cache_repo"
    else
        git clone $origin "$cache_repo" >/dev/null
    fi
    git -C "$cache_repo" archive --format=tar --prefix=src/ $hash | (cd "$JOB_DIR" && tar xf -)
elif [ -f "$JOB_DIR/private-origin.txt" ]; then
    origin=`cat $JOB_DIR/private-origin.txt`
    hash=`cat $JOB_DIR/hash.txt`
    rm "$JOB_DIR/private-origin.txt"
    git -C "$origin" archive --format=tar --prefix=src/ $hash | (cd "$JOB_DIR" && tar xf -)
elif [ -f "$JOB_DIR/archive.tar.gz" ]; then
    tar -xzf "$JOB_DIR/archive.tar.gz" -C "$job_src_dir"
    rm "$JOB_DIR/archive.tar.gz"
fi

cd "$job_src_dir"

patch_file="$JOB_DIR/git.patch"
if [ -f "$patch_file" ]; then
    cat "$patch_file" | patch -p0
fi

#INCLUDE jail.sh

function ts () {
    while IFS= read -r line; do printf '[%s][PREP] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" "$line"; done
}

prep_log="${JOB_DIR}/preparation.log"
install_script="${JOB_DIR}/src/.install"
if [ -f "$install_script" ]; then
    echo "Running .install script..." | ts >>"$prep_log"
    jail bash "$install_script" 2>&1 | ts >>"$prep_log"
    echo $? > "${JOB_DIR}/exit-status_preparation"
    echo "Finished .install script." | ts >>"$prep_log"
    sleep 2
fi
