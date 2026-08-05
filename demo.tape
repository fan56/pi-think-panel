Output "docs/demo.gif"
Set Width 2000
Set Height 800
Set FontSize 16
Set Padding 20
Set Framerate 10

# 1. start pi (TUI loads extensions incl. pi-think-panel)
Type "pi"
Enter
Sleep 30s

# 2. trigger a thinking turn
Type "13×17 等于多少？请先思考再回答"
Enter
Sleep 45s

# 3. ctrl+o opens the full-text overlay B
Ctrl+O
Sleep 3s

# 4. ctrl+o again back to small panel A
Ctrl+O
Sleep 2s

# 5. ctrl+h hides the small panel
Ctrl+H
Sleep 2s

# 6. exit
Type "/exit"
Enter
Sleep 2s
