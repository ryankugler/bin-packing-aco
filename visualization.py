import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.animation import FuncAnimation


def draw_rectangles(ax, rectangles, color, is_remaining=False):
    current_x, current_y = 0, 0
    padding = 0.2  # Padding between rectangles

    for rect in rectangles:
        if is_remaining:
            rect.x, rect.y = current_x, current_y
            current_x += rect.width + padding

            # TODO: Change animation of remaining rectangles to something more visually appealing?
            # if current_x + rect.width > ax.get_xlim()[1]:  # Move to the next line if out of bounds
            #     current_x = 0
            #     current_y += rect.height + padding

        ax.add_patch(
            patches.Rectangle(
                (rect.x, rect.y),  # Position of rectangle
                rect.width,        # Width of rectangle
                rect.height,       # Height of rectangle
                edgecolor='black', # Edge color of rectangle
                facecolor=color,   # Fill color of rectangle
                fill=True          # Fill rectangle
            )
        )

#update the plot for animation
def update(frame, packed_rectangles, remaining_rectangles, rectangles, bin_size, ax1, ax2, find_position_for_rectangle):
    if frame < len(rectangles):
        rect = rectangles[frame]
        x, y = find_position_for_rectangle(packed_rectangles, rect, bin_size)
        if x is not None:  # If a valid position is found
            rect.x, rect.y = x, y
            packed_rectangles.append(rect)
            if rect in remaining_rectangles:  # Ensure the rectangle is in the list
                remaining_rectangles.remove(rect)
                print(f"Packed rectangle {frame + 1}: {rect.width}x{rect.height} at position ({rect.x}, {rect.y})")

    ax1.clear()
    ax2.clear()

    #### Draw packed rectangles ####
    ax1.set_xlim(0, bin_size[0])
    ax1.set_ylim(0, bin_size[1])
    ax1.set_title('Packed Rectangles')
    draw_rectangles(ax1, packed_rectangles, 'blue')

    #### Draw remaining rectangles ####
    ax2.set_xlim(0, bin_size[0])  #provide extra space beyond bin size for better visualization
    ax2.set_ylim(0, bin_size[1])
    ax2.set_title('Remaining Rectangles')
    ax2.axis('off')
    draw_rectangles(ax2, remaining_rectangles, 'grey', is_remaining=True)

# set up and run the animation visualization
def run_animation(rectangles, bin_size, packed_rectangles, remaining_rectangles, find_position_for_rectangle):
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 6))
    
    anim = FuncAnimation(
        fig, update, 
        frames=len(rectangles), 
        fargs=(packed_rectangles, remaining_rectangles, rectangles, bin_size, ax1, ax2, find_position_for_rectangle), 
        repeat=False, 
        interval=200
    )
    plt.show()
