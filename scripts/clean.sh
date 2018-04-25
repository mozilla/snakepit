job_dir="$DATA_ROOT/jobs/$JOB_NUMBER"
rm -rf "$job_dir/tmp"
job_groups_dir="$job_dir/groups"
for dir in $job_groups_dir/*; do
    if [[ -d $dir ]]; then
        fusermount -u $dir
    fi
done
rm -rf "$job_dir/groups"
