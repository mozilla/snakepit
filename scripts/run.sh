
#INCLUDE jail.sh

gp="${GROUP_INDEX}_${PROCESS_INDEX}"
prefix=$(printf '%1u.%02u' $GROUP_INDEX $PROCESS_INDEX)

DECOUPLED=true jail "exit-status_${gp}" "$prefix" "process_${gp}.log" "compute"

echo "pid:${JOB_NUMBER}_${gp}"
