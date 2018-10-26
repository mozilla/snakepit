[[ $PID =~ ([^_]*)_([^_]*)_([^_]*) ]] 
jn="${BASH_REMATCH[1]}"
gi="${BASH_REMATCH[2]}"
pi="${BASH_REMATCH[3]}"
ps -e wwe | sed -e "s/[ ]*\([0-9]\+\).*JOB_NUMBER\=$jn.*GROUP_INDEX\=$gi.*PROCESS_INDEX\=$pi.*/\1/;t;d" | xargs -r kill -s KILL