set -e

mkdir "$JOB_DIR/tmp"
if [ -n "$CONTINUE_JOB_NUMBER" ]; then
    cp -r "$DATA_ROOT/jobs/$CONTINUE_JOB_NUMBER/keep" "$JOB_DIR/keep"
else
    mkdir "$JOB_DIR/keep"
fi

job_src_dir="$JOB_DIR/src"

if [ -n "$ORIGIN" ]; then
    mkdir -p "$DATA_ROOT/cache"
    cache_entry=`echo -n $ORIGIN | md5sum | cut -f1 -d" "`
    cache_repo="$DATA_ROOT/cache/$cache_entry"

    if [ -d "$cache_repo" ]; then
        git -C "$cache_repo" fetch --all >/dev/null
        touch "$cache_repo"
    else
        git clone $ORIGIN "$cache_repo" >/dev/null
    fi

    git -C "$cache_repo" archive --format=tar --prefix=src/ $HASH | (cd "$JOB_DIR" && tar xf -)
elif [ -n "$ARCHIVE" ]; then
    tar -xzf "$ARCHIVE" -C "$job_src_dir"
    rm "$ARCHIVE"
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
echo "Running install script..." | ts >>"$prep_log"
jail "bash ../install.sh; echo \$? >../exit-status_preparation" 2>&1 | ts >>"$prep_log"
echo "Finished install script."  | ts >>"$prep_log"
