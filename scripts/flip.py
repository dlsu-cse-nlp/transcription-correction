def reverse_jsonl(input_file, output_file):
    """Reverses the line order of a JSONL file."""
    with open(input_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.writelines(reversed(lines))
