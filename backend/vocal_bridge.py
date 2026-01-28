import requests


class VocalBridgeClient:
    """Client for the Vocal Bridge AI API to obtain LiveKit tokens and agent info."""

    BASE_URL = "http://vocalbridgeai.com/api/v1"

    def __init__(self, api_key):
        self.api_key = api_key
        self.headers = {
            "X-API-Key": api_key,
            "Content-Type": "application/json",
        }

    def get_token(self, participant_name):
        """Request a LiveKit token for the given participant."""
        try:
            response = requests.post(
                f"{self.BASE_URL}/token",
                headers=self.headers,
                json={"participant_name": participant_name},
                timeout=10,
            )
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            return {"error": str(e)}

    def get_agent_info(self):
        """Retrieve agent configuration from the API."""
        try:
            response = requests.get(
                f"{self.BASE_URL}/agent",
                headers=self.headers,
                timeout=10,
            )
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            return {"error": str(e)}
