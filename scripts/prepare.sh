set -o pipefail
(
echo "Preparation started..."

set -ex
set -o pipefail

mkdir "$JOB_DIR/tmp"
if [ -n "$CONTINUE_JOB_NUMBER" ]; then
    cp -r "$DATA_ROOT/pits/$CONTINUE_JOB_NUMBER/keep" "$JOB_DIR/keep"
else
    mkdir "$JOB_DIR/keep"
fi

job_src_dir="$JOB_DIR/src"

if [ -f "$JOB_DIR/origin" ]; then
    origin=$(<"$JOB_DIR/origin")
fi

if [ -f "$JOB_DIR/hash" ]; then
    hash=$(<"$JOB_DIR/hash")
fi

archive="$JOB_DIR/archive.tar.gz"

if [ -n "$origin" ]; then
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
elif [ -f "$archive" ]; then
    tar -xzf "$archive" -C "$job_src_dir"
    rm "$archive"
else
    mkdir "$job_src_dir"
fi

cd "$job_src_dir"
patch_file="$JOB_DIR/git.patch"
if [ -f "$patch_file" ]; then
    cat "$patch_file" | patch -p0
fi

echo "Preparation done."
) 2>&1 | ts '[%Y-%m-%d %H:%M:%S] [prepare]' >>"$JOB_DIR/pit.log"
