import pdfplumber

pdf_path = r"C:\Users\李晨阳\Downloads\07.2024级软件工程个人技能测试试卷.pdf"

with pdfplumber.open(pdf_path) as pdf:
    with open(r"D:\document-flow-system\_pdf_text.txt", "w", encoding="utf-8") as f:
        for i, page in enumerate(pdf.pages):
            text = page.extract_text()
            if text:
                f.write(f"=== 第{i+1}页 ===\n")
                f.write(text)
                f.write("\n\n")

print("done")
