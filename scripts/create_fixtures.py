from pathlib import Path


MD = """# Sample Quiz: Computer Basics

Multiple Choice
Q1. What does CPU stand for? (2 points)
A. Central Processing Unit
**B. Computer Personal Unit**
C. Central Program Utility
D. Common Programming Utility

Q2. What is 2 + 2? (2 points)
A. 3
**B. 4**
C. 5
D. 6

Q3. Who wrote "Hamlet"? (2 points)
A. **Charles Dickens**
B. William Shakespeare
C. Mark Twain
D. Jane Austen

Q4. Which language runs in a web browser? (2 points)
A. Python
**B. JavaScript**
C. C++
D. Java

Q5. What does HTML stand for? (2 points)
A. **Hyper Text Markup Language**
B. High Tech Modern Language
C. Hyper Transfer Markup Language
D. Home Tool Markup Language

True or False
Q6. The CPU is the brain of the computer. (1 point)
**True**

Q7. HTML stands for Hyper Text Markup Language. (1 point)
**True**

Q8. JavaScript is a compiled language. (1 point)
**False**

Identification
Q9. What does IP stand for? (2 points)
**Internet Protocol**

Q10. What does URL stand for? (2 points)
**Uniform Resource Locator**

Fill in the Blank(s)
Q11. The **____** controls all other components in a computer. (2 points)

Q12. The **____** is known as the brain of the computer. (2 points)

Enumeration
Q13. List three input devices. (3 points)
Answers (3): **Keyboard**, **Mouse**, **Scanner**

Problem Solving
Q14. Solve for x: 2x + 3 = 11. (5 points)
**4**

Matching
Match each part with its function.

| Column A | Answer | Match |
|---|---|---|
| CPU | processes data | A |
| RAM | short-term memory | B |
| GPU | renders graphics | C |
| PSU | supplies power | D |
| | unmatched | |

Connect
Connect each device to its connection type.

| Prompts | Answers | Connect |
|---|---|---|
| Keyboard | USB | A |
| Mouse | Bluetooth | B |
| Monitor | HDMI | C |
| Speaker | Audio | D |
| | unmatched | |
"""


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    fixture_dir = root / "tests" / "fixtures"
    fixture_dir.mkdir(parents=True, exist_ok=True)

    (fixture_dir / "Sample_Quiz_Computer_Basics.md").write_text(MD, encoding="utf-8")
    (fixture_dir / "Sample_Quiz_Computer_Basics.markdown").write_text(MD, encoding="utf-8")

    print(f"wrote {fixture_dir / 'Sample_Quiz_Computer_Basics.md'} and .markdown")


if __name__ == "__main__":
    main()
