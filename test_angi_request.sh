#!/bin/bash

curl -X POST "https://www.zoomdrain-phxev.com/webhooks/angi/test" \
  -H "Content-Type: application/json" \
  -H "x-api-key: 4121eb43445d0d043ef05c0dbba1940bfee4c505de3a44b6240bd30157b734fa" \
  -d '{
    "name": "Fred Flintstone",
    "firstName": "Fred",
    "lastName": "Flintstone",
    "address": "3842 N 32nd Street",
    "city": "Phoenix",
    "stateProvince": "AZ",
    "postalCode": "85018",
    "primaryPhone": "+16232322667",
    "secondaryPhone": null,
    "email": "sarah.johnson@example.com",
    "srOid": 112233445,
    "leadOid": 998877665,
    "fee": 0.0,
    "taskName": "Drain Cleaning - Clear Blockage",
    "comments": "Main bathroom drain is completely clogged. Water backs up into the tub when the toilet flushes. Has been getting worse over the past week.",
    "matchType": "Lead",
    "leadDescription": "Standard",
    "leadSource": "AngiesList",
    "interview": [
      { "question": "What type of drain needs cleaning?", "answer": "Bathroom sink and tub" },
      { "question": "Is the drain completely blocked?", "answer": "Yes, completely blocked" },
      { "question": "When do you need this done?", "answer": "As soon as possible - it is urgent" }
    ],
    "automatedContactCompliant": true,
    "automatedContactConsentId": "223e4567-e89b-12d3-a456-426614174001"
  }'
