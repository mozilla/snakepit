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
archive="$JOB_DIR/archive.tar.gz"

if [ -f "$JOB_DIR/origin" ]; then
    echo "Git based"
    origin=$(<"$JOB_DIR/origin")
    git clone $origin "$job_src_dir"
    cd "$job_src_dir"
    if [ -f "$JOB_DIR/hash" ]; then
        hash=$(<"$JOB_DIR/hash")
        git reset --hard $hash
    fi
    git lfs fetch
    git lfs checkout
elif [ -f "$archive" ]; then
    echo "Archive based"
    mkdir "$job_src_dir"
    tar -xf "$archive" -C "$job_src_dir"
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
