#!/bin/bash
set -euo pipefail

LOG_FILE="/Users/admin/prism/training/output_grpo_resume.log"
TRAINING_DIR="/Users/admin/prism/training"
EVAL_RESULTS="$TRAINING_DIR/output/bfcl-32b/eval_results.log"

echo "Monitoring training pipeline for completion..."
tail -f "$LOG_FILE" | while read -r line; do
    if [[ "$line" == *"Pipeline complete!"* ]]; then
        pkill -f "tail -f $LOG_FILE"
        break
    elif [[ "$line" == *"ERROR"* ]] || [[ "$line" == *"WATCHDOG KILL"* ]]; then
        pkill -f "tail -f $LOG_FILE"
        osascript -e 'display notification "Training Failed!" with title "Prism Training Error"'
        exit 1
    fi
done

echo "Training finished. Checking benchmark results..."

# Parse the accuracy from the eval log (assuming a line like "Total Accuracy: 82.5%")
# Or "Pass rate: 82.5%" depending on bfcl_eval.py output format
cd "$TRAINING_DIR"

if [ -f "$EVAL_RESULTS" ]; then
    # Looking for a line that indicates overall success or specific category failures
    # If eval_results.log contains something we can parse, we will do it here.
    # For now, let's just trigger a notification so the user knows it finished.
    osascript -e 'display notification "Benchmarks completed. Check eval_results.log" with title "Prism Training"'
else
    osascript -e 'display notification "Benchmarks failed to produce a log!" with title "Prism Training Error"'
fi
