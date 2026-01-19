REGION=us-central1
SERVICE=square-inventory-sync

REV=$(gcloud run services describe $SERVICE --region $REGION --format="value(status.latestCreatedRevisionName)")
echo "Latest created revision: $REV"

gcloud logging read \
'resource.type="cloud_run_revision"
 AND resource.labels.service_name="'$SERVICE'"
 AND resource.labels.revision_name="'$REV'"' \
--limit 200 \
--format="value(textPayload)"

