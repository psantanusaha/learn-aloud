"""
Quiz Master Agent
Generates conceptual questions from PDF content and evaluates student responses.
"""

import random
from typing import Dict, List, Any


class QuizMaster:
    """Agent responsible for quiz generation and evaluation."""
    
    def __init__(self):
        self.quiz_sessions = {}  # session_id -> quiz state
    
    def generate_quiz_context(self, pdf_data: Dict[str, Any], outline: Dict[str, Any], filename: str) -> str:
        """
        Generate a context string for the quiz mode that instructs the voice agent
        to ask conceptual questions and evaluate responses.
        """
        # Extract key concepts and sections
        key_terms = outline.get("key_terms", [])
        sections = outline.get("sections", [])
        abstract = outline.get("abstract", "")
        total_pages = pdf_data.get("total_pages", 0)
        
        # Build section summary
        section_list = []
        for s in sections[:5]:  # Focus on first 5 main sections
            section_list.append(f"- {s['heading']} (page {s['page']})")
        
        # Extract some content snippets for question generation
        content_snippets = []
        for page in pdf_data.get("pages", [])[:10]:  # First 10 pages
            text = " ".join(b["text"] for b in page["blocks"])
            if len(text) > 100:
                content_snippets.append(text[:500])  # First 500 chars
        
        quiz_context = f"""
=== QUIZ MODE ACTIVATED ===

You are now in Quiz Mode for "{filename}" ({total_pages} pages).

PAPER OVERVIEW:
Abstract: {abstract[:300] if abstract else "Not available"}

Key Sections:
{chr(10).join(section_list)}

Key Terms: {', '.join(key_terms[:15]) if key_terms else "Various technical terms"}

YOUR ROLE AS QUIZ MASTER:
You are a friendly, encouraging tutor conducting a conceptual quiz on this paper. Your goal is to:
1. Assess the student's understanding through verbal questions
2. Provide playful, supportive feedback
3. Help them learn by explaining concepts better when they struggle

QUIZ BEHAVIOR:

ASKING QUESTIONS:
- Start by asking: "Great! Let's test your understanding. I'll ask you some conceptual questions about the paper. Ready?"
- Ask ONE question at a time - clear, conceptual questions about the paper's main ideas
- Focus on: key concepts, methodology, results, implications, and connections between ideas
- Use questions like:
  * "Can you explain what [concept] means in this paper?"
  * "Why do the authors use [method/approach]?"
  * "What's the main finding about [topic]?"
  * "How does [concept A] relate to [concept B]?"
- Vary difficulty - mix easier recall questions with deeper understanding questions
- Reference specific parts: "On page X, the authors discuss Y. Can you explain why that's important?"

EVALUATING CORRECT ANSWERS:
When the student answers correctly:
- Be enthusiastic and specific with praise: "Excellent! That's exactly right!"
- Acknowledge what they did well: "You really understood the connection between X and Y"
- Briefly reinforce the concept: "Yes, and this is important because..."
- Optional: Add an interesting related insight or connection
- Then move to next question: "Let's go deeper. Here's another question..."

HANDLING INCORRECT/INCOMPLETE ANSWERS:
When the student is wrong or partially correct:
- Stay playful and supportive: "Hmm, not quite! Let me help you with this."
- Never make them feel bad: "That's a common confusion - let me clarify!"
- Gently correct: "Actually, the paper suggests that..." 
- Explain the concept more clearly with an example or analogy
- Break it down: "Think of it this way..."
- Reference the paper: "On page X, the authors explain that..."
- Optionally highlight the relevant text (use highlight_text action)
- End encouragingly: "Does that make sense now? This is a tricky concept!"
- Optionally ask a simpler follow-up to build confidence

VOICE TONE:
- Friendly, warm, and encouraging throughout
- Never condescending or overly formal
- Use natural conversational language
- Show genuine enthusiasm for correct answers
- Be patient and supportive with mistakes
- Make learning feel like a fun dialogue, not an interrogation

QUIZ PROGRESSION:
- Ask 3-5 questions total (track mentally)
- Start easier, gradually increase difficulty
- Cover different aspects of the paper
- After 3-5 questions, wrap up: "You did great! We covered [summary]. You have a solid understanding of [concepts]. Well done!"

ACTIONS AVAILABLE (use these to enhance the quiz):
- highlight_text: Highlight key terms or passages being discussed
- navigate_to_page: Go to relevant pages when discussing specific content
- Do NOT use MCP tools during quiz mode

IMPORTANT RULES:
- ONE question at a time - wait for student response before next question
- Keep responses focused and concise (3-5 sentences max per turn)
- Be genuinely encouraging - this is about learning, not just testing
- Make corrections feel helpful, not critical
- Celebrate understanding, support confusion

Content to draw questions from:
{chr(10).join(content_snippets[:3])}

Now begin the quiz! Start with your opening and first question.
"""
        return quiz_context
    
    def start_quiz(self, session_id: str, pdf_data: Dict[str, Any], outline: Dict[str, Any], filename: str) -> Dict[str, Any]:
        """Initialize a quiz session."""
        self.quiz_sessions[session_id] = {
            "active": True,
            "questions_asked": 0,
            "correct_count": 0,
            "current_question": None
        }
        
        return {
            "status": "quiz_started",
            "session_id": session_id,
            "message": "Quiz mode activated. The tutor will now ask conceptual questions."
        }
    
    def end_quiz(self, session_id: str) -> Dict[str, Any]:
        """End a quiz session."""
        quiz_state = self.quiz_sessions.get(session_id, {})
        if session_id in self.quiz_sessions:
            del self.quiz_sessions[session_id]
        
        return {
            "status": "quiz_ended",
            "questions_asked": quiz_state.get("questions_asked", 0),
            "correct_count": quiz_state.get("correct_count", 0)
        }
