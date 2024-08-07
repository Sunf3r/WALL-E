from rembg import remove
from PIL import Image
import sys

# This plugin removes background from images
# You can use it on main thread with RunCode function on runner.ts
def remove_bg(input_path, outputpath):
    original_img = Image.open(input_path)
    no_bg_img = remove(original_img)
    no_bg_img.save(outputpath)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python removeBg.py <input_path> <output_path>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    remove_bg(input_path, output_path)