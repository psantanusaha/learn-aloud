import pytest
from app import app as flask_app
import io

@pytest.fixture
def app():
    yield flask_app

@pytest.fixture
def client(app):
    return app.test_client()

def test_index_not_found(client):
    """Test that the index route returns a 404 Not Found."""
    response = client.get('/')
    assert response.status_code == 404

def test_upload_pdf_no_file(client):
    """Test the /api/upload-pdf endpoint with no file."""
    response = client.post('/api/upload-pdf')
    assert response.status_code == 400
    json_data = response.get_json()
    assert json_data['error'] == 'No file provided'

def test_upload_pdf_not_pdf(client):
    """Test the /api/upload-pdf endpoint with a non-PDF file."""
    data = {
        'file': (io.BytesIO(b"this is a test"), 'test.txt')
    }
    response = client.post('/api/upload-pdf', data=data, content_type='multipart/form-data')
    assert response.status_code == 400
    json_data = response.get_json()
    assert json_data['error'] == 'Only PDF files are accepted'

def test_upload_pdf_success(client, mocker):
    """Test the /api/upload-pdf endpoint with a valid PDF file."""
    # Mock the pdf_processor to avoid actual PDF processing
    mocker.patch('app.pdf_processor.extract_structure', return_value={'total_pages': 5})
    
    data = {
        'file': (io.BytesIO(b"%PDF-1.5..."), 'test.pdf')
    }
    response = client.post('/api/upload-pdf', data=data, content_type='multipart/form-data')
    assert response.status_code == 200
    json_data = response.get_json()
    assert 'session_id' in json_data
    assert json_data['filename'] == 'test.pdf'
    assert json_data['total_pages'] == 5
